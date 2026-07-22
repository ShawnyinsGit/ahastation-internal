// opencode-adapter.ts — OpenCode AI coding agent backend adapter.
//
// Architecture (rewritten in Phase 2 PR①):
//   AhaMeet main process
//     └── opencode serve (spawned by opencode-server-process.ts: bundled
//         binary, env whitelist, per-launch random Basic-auth password)
//           └── one session per meeting participant
//
// Event pipeline (all conclusions from docs/spike-opencode-server.md):
//   - Events come from the PER-INSTANCE /event endpoint over a fetch-based
//     SSE stream carrying the Authorization header — the old code used
//     `new EventSource(url)` which is not a global in Electron's main
//     process (verified: embedded Node v24, typeof EventSource ===
//     'undefined'), and a bare EventSource couldn't send Basic auth anyway.
//   - SUBSCRIBE-BEFORE-CREATE is a hard order: the stream must be live
//     before session.create, because the server has no replay and no
//     Last-Event-ID (spike §5) — anything emitted in between is lost.
//   - Stream loss → checkpoint-resync: re-subscribe (buffering new events),
//     pull a full session.messages (+todo/diff) snapshot, merge
//     (messageID, partID) last-write-wins, resume playback.
//   - `directory` on every client call is pinned to the cwd this server was
//     spawned with (spike §4: the directory query param re-roots file APIs
//     arbitrarily — it must never come from outside).
//   - permission.updated events are BUFFERED into pendingPermissions —
//     neither emitted nor dropped; Phase 2 PR② wires the PermissionBroker.
//   - todo.updated / session.diff are stashed for the PR③ editor panel.

import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  CliBackend,
  InputPriority,
  UserContentBlock,
} from './cli-backend.js';
import {
  basicAuthHeader,
  resolveOpencodeBinary,
  type OpencodeServerHandle,
} from './opencode-server-process.js';
import {
  createSseParser,
  extractEventSessionId,
  mapPartToNormalizedMessage,
  mergeResyncParts,
  partKeyOf,
} from './opencode-events.js';
import {
  PermissionBroker,
  type BrokerDecisionReason,
  type BrokerPermissionRequest,
  type OpencodePermissionResponse,
} from '../permission-broker.js';
import {
  EditorPanelStore,
  type EditorPanelEvent,
  type EditorSnapshot,
} from './opencode-editor-panel.js';
import {
  bindEditorSession,
  forwardToEditorWindow,
  unbindEditorSession,
} from '../ide/ide-window-manager.js';
import {
  defaultServerSpawn,
  getOpencodeServerRegistry,
} from '../ide/opencode/opencode-server-registry.js';

// ── SDK client (dynamic import so app startup isn't blocked) ────────────────

type OpencodeClientModule = typeof import('@opencode-ai/sdk/client');
type OpencodeClient = import('@opencode-ai/sdk/client').OpencodeClient;

let clientModuleCache: OpencodeClientModule | null | undefined;

async function loadOpencodeClientModule(): Promise<OpencodeClientModule | null> {
  if (clientModuleCache !== undefined) return clientModuleCache;
  try {
    clientModuleCache = await import('@opencode-ai/sdk/client');
    return clientModuleCache;
  } catch {
    clientModuleCache = null;
    return null;
  }
}

// ── Capabilities ────────────────────────────────────────────────────────────

const OPENCODE_CAPABILITIES: BackendCapabilities = {
  coordinate: true,
  executeTasks: true,
  displayName: 'OpenCode',
  iconId: 'opencode',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: false,
  interrupt: true,
  defaultModel: 'anthropic/claude-sonnet-4-5',
  models: [
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-haiku-4-5',
    'openai/gpt-5.4',
    'openai/gpt-5.4-mini',
  ],
  npmPackage: 'opencode-ai',
  installHint: 'npm install opencode-ai',
};

/** Pinned server config (serialized into OPENCODE_CONFIG_CONTENT): every
 *  tool call asks for permission. Requests buffer in pendingPermissions
 *  until the Phase 2 PR② PermissionBroker answers them — server-side the
 *  tool call blocks, nothing is auto-allowed. Exact permission-key coverage
 *  gets validated with a live provider key (spike §7 follow-up). Exported
 *  for the PTY manager, which spawns servers on the same pinned config. */
export const OPENCODE_SERVER_CONFIG: Record<string, unknown> = {
  permission: { '*': 'ask' },
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Human-readable one-liner for an instance-level event (activity feed). */
function describeInstanceEvent(type: string, properties: unknown): string {
  const p = (properties ?? {}) as Record<string, unknown>;
  const file = typeof p.file === 'string' ? p.file : null;
  switch (type) {
    case 'file.edited':
      return `编辑文件 ${file ?? ''}`.trim();
    case 'file.watcher.updated':
      return `文件${p.event === 'add' ? '新增' : p.event === 'unlink' ? '删除' : '变更'} ${file ?? ''}`.trim();
    case 'vcs.branch.updated':
      return `分支切换到 ${typeof p.branch === 'string' ? p.branch : '(unknown)'}`;
    case 'server.connected':
      return 'server 事件流已连接';
    default:
      return file ? `${type} ${file}` : type;
  }
}

// ── Session implementation ──────────────────────────────────────────────────

type ServerEvent = { type: string; properties: unknown };

class OpenCodeSession implements BackendSession {
  private server: OpencodeServerHandle | null = null;
  private client: OpencodeClient | null = null;
  private sessionId: string | null = null;
  private closed = false;
  private ready = false;

  // Stream / resync state.
  private streamAbort: AbortController | null = null;
  private buffering = false;
  private eventBuffer: ServerEvent[] = [];
  private partRevisions = new Map<string, string>();
  private firstStreamOpened: Promise<void>;
  private firstStreamOpenedResolve!: () => void;
  private firstStreamOpenedReject!: (err: unknown) => void;
  private firstStreamSettled = false;

  // Phase 2 PR②: permission requests are decided by the broker (auto-approve
  // / native confirm / meeting-UI card / fail-closed timeout), which answers
  // the server via replyPermission below.
  private broker: PermissionBroker | null = null;
  // Phase 2 PR③: editor panel store — status light, todo/diff snapshots and
  // the capped activity timeline. Digested events feed it; the incremental
  // results fan out point-to-point to this hostId's editor window, and a
  // freshly opened/re-attached window pulls the full snapshot.
  private readonly panel = new EditorPanelStore();

  constructor(
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
  ) {
    this.firstStreamOpened = new Promise<void>((resolve, reject) => {
      this.firstStreamOpenedResolve = resolve;
      this.firstStreamOpenedReject = reject;
    });
  }

  async start(): Promise<void> {
    try {
      const handle = await this.acquireServer();
      this.server = handle;

      const sdk = await loadOpencodeClientModule();
      if (!sdk) {
        handle.kill();
        this.emit({ kind: 'error', error: 'OpenCode SDK client not available' });
        return;
      }
      this.client = sdk.createOpencodeClient({
        baseUrl: handle.url,
        // Pinned to the cwd this server was spawned with — never an
        // externally supplied value (spike §4: directory re-roots file APIs).
        directory: this.config.cwd,
        headers: { authorization: basicAuthHeader(handle.password) },
      });

      // Permission bridge (Phase 2 PR②): decides each permission.updated
      // request (auto-approve / native confirm / meeting-UI card / fail-
      // closed timeout) and answers the server via POST /session/{id}/
      // permissions/{permissionID}.
      this.broker = new PermissionBroker({
        getAutoApproveScope: () => this.config.autoApproveScope ?? 'off',
        confirmDestructive: this.config.confirmDestructive,
        reply: (request, response, reason) => this.replyPermission(request, response, reason),
        emitToMeeting: (event) => this.emit(event),
      });

      handle.onExit((code, signal) => this.onServerExit(code, signal));
      this.runStreamLoop();

      // Subscribe-before-create: wait for the event stream to be live
      // BEFORE creating the session (no server-side replay — spike §5).
      await this.firstStreamOpened;

      const created = await this.client.session.create({
        query: { directory: this.config.cwd },
        body: { title: `AhaMeet ${this.config.cwd}` },
      });
      if (!created.data) {
        throw new Error('Failed to create OpenCode session');
      }
      this.sessionId = created.data.id;
      this.ready = true;
      // Bind hostId ↔ opencode sessionID so panel events can fan out
      // point-to-point to this host's editor window (§2.2 rule 7).
      if (this.config.hostId) {
        bindEditorSession(this.config.hostId, this.sessionId);
      }

      this.emit({
        kind: 'message',
        message: {
          type: 'system',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'OpenCode 会话已启动' }],
          },
        },
      });
    } catch (err) {
      this.emit({ kind: 'error', error: `OpenCode start failed: ${String(err)}` });
    }
  }

  /** Single seam for obtaining a server handle: the shared per-(meetingId,
   *  cwd) registry (Phase 3). Same meeting + cwd → same server, refcounted;
   *  the last release kills it. Everything else here still talks to the
   *  handle, never to the process directly. */
  private acquiredServerKey: string | null = null;

  private async acquireServer(): Promise<OpencodeServerHandle> {
    const acquired = await getOpencodeServerRegistry().acquire({
      meetingId: this.config.meetingId ?? 'default',
      cwd: this.config.cwd,
      spawn: () => defaultServerSpawn({
        cwd: this.config.cwd,
        config: OPENCODE_SERVER_CONFIG,
        providerEnv: this.config.env,
      }),
    });
    this.acquiredServerKey = acquired.key;
    return acquired.handle;
  }

  // ── Event stream with checkpoint-resync ─────────────────────────────────

  private runStreamLoop(): void {
    void (async () => {
      let backoff = 250;
      while (!this.closed && this.server) {
        const server = this.server;
        // Buffer events from the moment we (re)subscribe until the snapshot
        // merge has run — that's the resync gap window.
        this.eventBuffer = [];
        this.buffering = true;

        let res: Response;
        try {
          this.streamAbort = new AbortController();
          res = await fetch(`${server.url}/event`, {
            headers: { authorization: basicAuthHeader(server.password) },
            signal: this.streamAbort.signal,
          });
          if (!res.ok || !res.body) {
            throw new Error(`event stream HTTP ${res.status}`);
          }
        } catch (err) {
          if (this.closed) return;
          this.settleFirstStream(err, false);
          console.warn('[opencode] event stream connect failed:', err);
          await sleepMs(backoff);
          backoff = Math.min(backoff * 2, 5000);
          continue;
        }

        this.settleFirstStream(undefined, true);
        backoff = 250;

        try {
          await this.resyncSnapshot();
        } catch (err) {
          console.warn('[opencode] resync snapshot failed:', err);
          await res.body.cancel().catch(() => undefined);
          await sleepMs(backoff);
          continue;
        }

        // Snapshot merged; buffered events consumed → go live.
        this.buffering = false;
        this.eventBuffer = [];

        try {
          await this.pumpStream(res.body);
        } catch (err) {
          if (this.closed) return;
          console.warn('[opencode] event stream lost:', err);
        }
        // Stream ended unexpectedly → loop: re-subscribe + resync.
      }
    })();
  }

  private settleFirstStream(err: unknown, ok: boolean): void {
    if (this.firstStreamSettled) return;
    this.firstStreamSettled = true;
    if (ok) this.firstStreamOpenedResolve();
    else this.firstStreamOpenedReject(err);
  }

  private async pumpStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser((data) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(data) as ServerEvent;
      } catch {
        console.warn('[opencode] unparseable event frame');
        return;
      }
      this.dispatchServerEvent(event);
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      parser.push(decoder.decode(value, { stream: true }));
    }
  }

  private dispatchServerEvent(event: ServerEvent): void {
    if (this.closed || typeof event?.type !== 'string') return;
    if (this.buffering) {
      this.eventBuffer.push(event);
      return;
    }
    this.routeEvent(event.type, event.properties);
  }

  /** Pull a full snapshot and merge it with events buffered during the
   *  resync window. Dedupe: (messageID, partID) last-write-wins, buffered
   *  events win over the snapshot (they are newer). */
  private async resyncSnapshot(): Promise<void> {
    if (!this.client || !this.sessionId) {
      // First connect — no session exists yet, nothing to resync.
      this.eventBuffer = [];
      return;
    }
    const [messages, todo, diff] = await Promise.all([
      this.client.session.messages({ path: { id: this.sessionId } }),
      this.client.session.todo({ path: { id: this.sessionId } }).catch(() => null),
      this.client.session.diff({ path: { id: this.sessionId } }).catch(() => null),
    ]);

    const snapshotParts = (messages.data ?? []).flatMap((m) => m.parts ?? []);
    if (todo?.data) this.feedPanel(this.panel.setTodos(todo.data));
    if (diff?.data) this.feedPanel(this.panel.setDiff(diff.data));

    const bufferedParts = this.eventBuffer
      .filter((e) => e.type === 'message.part.updated')
      .map((e) => (e.properties as { part?: unknown }).part)
      .filter((p): p is NonNullable<typeof p> => p != null);

    const merged = mergeResyncParts(snapshotParts, bufferedParts);
    for (const part of merged) {
      this.emitPartIfChanged(part);
    }
    // Non-part events buffered during the window replay after the merge.
    for (const e of this.eventBuffer) {
      if (e.type !== 'message.part.updated') {
        this.routeEvent(e.type, e.properties);
      }
    }
    this.eventBuffer = [];
  }

  private emitPartIfChanged(part: unknown): void {
    if (part == null) return;
    const key = partKeyOf(part as { messageID?: unknown; id?: unknown });
    const json = safeJson(part);
    if (key) {
      if (this.partRevisions.get(key) === json) return;
      this.partRevisions.set(key, json);
    }
    const msg = mapPartToNormalizedMessage(part, part);
    if (msg) {
      this.emit({ kind: 'message', message: msg });
    }
    this.feedPanelForPart(part);
  }

  // ── Editor panel feed (Phase 2 PR③) ───────────────────────────────────────

  /** Forward incremental panel events point-to-point to this hostId's editor
   *  window. No window → the store still holds the latest state in main; a
   *  re-attached window pulls it via ide-editor:get-state. Never broadcast. */
  private feedPanel(events: EditorPanelEvent | EditorPanelEvent[] | null): void {
    if (!events || !this.config.hostId) return;
    for (const ev of Array.isArray(events) ? events : [events]) {
      forwardToEditorWindow(this.config.hostId, ev);
    }
  }

  private feedPanelForPart(part: unknown): void {
    const p = part as Record<string, unknown>;
    if (p.type === 'text' && typeof p.text === 'string' && p.text.length > 0) {
      this.feedPanel(this.panel.noteText(String(p.messageID ?? ''), p.text));
      return;
    }
    if (p.type === 'tool') {
      const state = (p.state ?? {}) as Record<string, unknown>;
      this.feedPanel(this.panel.noteToolCall(
        String(p.callID ?? p.id ?? ''),
        typeof p.tool === 'string' ? p.tool : 'unknown',
        typeof state.status === 'string' ? state.status : 'pending',
        (state.input ?? undefined) as Record<string, unknown> | undefined,
      ));
    }
  }

  /** Snapshot consumed by the ide-editor:get-state IPC (editor window init
   *  and re-attach). Optional adapter-specific method — NOT part of the
   *  BackendSession contract. */
  getEditorSnapshot(): EditorSnapshot {
    return this.panel.snapshot();
  }

  // ── Event routing / attribution ─────────────────────────────────────────

  private routeEvent(type: string, properties: unknown): void {
    const sid = extractEventSessionId(type, properties);
    if (sid === null) {
      // Instance-level event (file.edited / watcher / vcs / lsp / pty /
      // server.connected ...). One server per participant today, so it is
      // THIS participant's activity — surfaced in the editor activity feed.
      this.feedPanel(this.panel.noteInstanceActivity(describeInstanceEvent(type, properties)));
      return;
    }
    if (!this.sessionId || sid !== this.sessionId) return; // not our session

    switch (type) {
      case 'message.part.updated': {
        const part = (properties as { part?: unknown }).part;
        this.emitPartIfChanged(part);
        return;
      }
      case 'message.updated': {
        const info = (properties as {
          info?: { role?: string; error?: { name?: string; data?: { message?: string } } };
        }).info;
        if (info?.role === 'assistant' && info.error) {
          const detail = info.error.data?.message ?? info.error.name ?? 'unknown';
          this.feedPanel(this.panel.setError(detail));
          if (info.error.name === 'ProviderAuthError') {
            this.emit({ kind: 'auth-required', error: `OpenCode provider auth failed: ${detail}` });
          } else {
            this.emit({ kind: 'error', error: `OpenCode message error: ${detail}` });
          }
        }
        return;
      }
      case 'session.idle':
        // Turn finished — maps to the same 'result' semantic the worker
        // scheduler uses to clear busy state.
        this.feedPanel(this.panel.setStatus('idle'));
        this.emit({ kind: 'message', message: { type: 'result', raw: properties } });
        return;
      case 'session.status': {
        const status = (properties as { status?: { type?: string; message?: string } }).status;
        if (status?.type === 'busy') {
          this.feedPanel(this.panel.setStatus('busy'));
        } else if (status?.type === 'idle') {
          this.feedPanel(this.panel.setStatus('idle'));
        } else if (status?.type === 'retry') {
          this.feedPanel(this.panel.setStatus('retry'));
          this.emit({
            kind: 'message',
            message: {
              type: 'system',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: `OpenCode 重试中：${status.message ?? ''}` }],
              },
            },
          });
        }
        return;
      }
      case 'session.error': {
        const err = (properties as { error?: { name?: string; data?: { message?: string } } }).error;
        const detail = err?.data?.message ?? err?.name ?? 'unknown session error';
        this.feedPanel(this.panel.setError(detail));
        if (err?.name === 'ProviderAuthError') {
          this.emit({ kind: 'auth-required', error: detail });
        } else {
          this.emit({ kind: 'error', error: detail });
        }
        return;
      }
      case 'permission.updated': {
        // Permission bridge: hand the request to the broker — it decides
        // (auto-approve / native confirm / UI card / fail-closed timeout)
        // and answers the server. Never dropped, never double-answered
        // (broker dedupes on the permission id).
        const perm = properties as {
          id?: string;
          type?: string;
          title?: string;
          sessionID?: string;
          metadata?: Record<string, unknown>;
        };
        if (!perm?.id || !this.broker) return;
        void this.broker.submit({
          id: perm.id,
          backendId: 'opencode',
          sessionID: perm.sessionID ?? sid,
          // opencode Permission.type carries the tool/permission kind
          // (bash/edit/...); title is the human description.
          toolName: perm.type ?? perm.title ?? 'unknown',
          input: perm.metadata ?? {},
          title: perm.title,
          metadata: perm.metadata,
        });
        return;
      }
      case 'permission.replied': {
        // Replied from ANY end (our own answers echo back too) — idempotent
        // dequeue + meeting-UI card withdrawal.
        const pid = (properties as { permissionID?: string }).permissionID;
        if (pid) this.broker?.cancelExternal(pid);
        return;
      }
      case 'todo.updated':
        this.feedPanel(this.panel.setTodos((properties as { todos?: unknown[] }).todos));
        return;
      case 'session.diff':
        this.feedPanel(this.panel.setDiff((properties as { diff?: unknown[] }).diff));
        return;
      default:
        // session.created/updated/deleted, message.removed, etc. — nothing
        // to surface yet.
        return;
    }
  }

  private onServerExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.emit({ kind: 'error', error: `OpenCode server exited (code=${code} signal=${signal})` });
  }

  // ── BackendSession contract ─────────────────────────────────────────────

  sendUserText(text: string, _priority?: InputPriority): void {
    if (!this.client || !this.sessionId || this.closed || !this.ready) return;
    void this.client.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: 'text', text }],
      },
    }).catch((err) => {
      this.emit({ kind: 'error', error: `OpenCode prompt failed: ${String(err)}` });
    });
  }

  sendUserContent(content: string | UserContentBlock[], _priority?: InputPriority): void {
    if (typeof content === 'string') {
      this.sendUserText(content);
      return;
    }
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) this.sendUserText(text);
  }

  /** Deliver the broker's answer to the opencode server:
   *  POST /session/{id}/permissions/{permissionID} { response }. */
  private replyPermission(
    request: BrokerPermissionRequest,
    response: OpencodePermissionResponse,
    reason: BrokerDecisionReason,
  ): void {
    console.log(`[opencode] permission ${request.id} (${request.toolName}) → ${response} [${reason}]`);
    if (!this.client || this.closed) return;
    void this.client.postSessionIdPermissionsPermissionId({
      path: { id: request.sessionID, permissionID: request.id },
      body: { response },
    }).then((res) => {
      if (res.error) {
        console.warn('[opencode] permission reply rejected by server:', res.error);
      }
    }).catch((err) => {
      console.warn('[opencode] permission reply failed:', err);
    });
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', _message?: string): void {
    // Broadcast chain: every session's adapter gets the call — the broker
    // acts only when it actually holds this permission id (mismatch no-op).
    this.broker?.resolveUi(id, decision);
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.sessionId || this.closed) return;
    try {
      await this.client.session.abort({
        path: { id: this.sessionId },
      });
    } catch (err) {
      console.warn('[opencode] interrupt failed:', err);
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.streamAbort?.abort();
    this.streamAbort = null;
    // fail-closed: deny everything still pending before tearing down (the
    // server is about to die anyway, but the reject also fires when only the
    // session is ending).
    this.broker?.rejectAll('shutdown');
    this.broker = null;
    if (this.config.hostId) {
      unbindEditorSession(this.config.hostId);
    }
    // Release the shared server refcount (sessionEnd lifecycle) instead of
    // killing directly — the server dies only when the last session/window
    // in this (meetingId, cwd) lets go. Deliberately NO session.delete.
    if (this.acquiredServerKey) {
      void getOpencodeServerRegistry().handleLifecycle('sessionEnd', this.acquiredServerKey);
      this.acquiredServerKey = null;
    }
    this.server = null;
    this.client = null;
    this.emit({ kind: 'ended' });
    this.emit = () => {};
  }
}

// ── Backend factory ─────────────────────────────────────────────────────────

/** Env var pair for the provider an opencode model id belongs to
 *  ('anthropic/claude-…' → ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL). The two
 *  providers we ship models for are explicit; any other provider prefix
 *  falls back to the <PROVIDER>_API_KEY / <PROVIDER>_BASE_URL convention. */
function providerEnvVars(model?: string): { keyVar: string; baseUrlVar: string } {
  const provider = (model ?? '').split('/')[0]?.toLowerCase() || 'anthropic';
  switch (provider) {
    case 'openai':
      return { keyVar: 'OPENAI_API_KEY', baseUrlVar: 'OPENAI_BASE_URL' };
    case 'anthropic':
      return { keyVar: 'ANTHROPIC_API_KEY', baseUrlVar: 'ANTHROPIC_BASE_URL' };
    default: {
      const p = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      return { keyVar: `${p}_API_KEY`, baseUrlVar: `${p}_BASE_URL` };
    }
  }
}

export class OpenCodeBackend implements CliBackend {
  readonly id = 'opencode';
  readonly capabilities = OPENCODE_CAPABILITIES;

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new OpenCodeSession(config, emit);
  }

  resolveBinary(): string | null {
    // Real path of the bundled opencode-<platform>-<arch> binary, or null
    // when the platform package is not installed. (No more 'sdk' sentinel —
    // the availability probe now reflects the actual spawn prerequisite.)
    return resolveOpencodeBinary();
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // The server env is whitelist-built inside opencode-server-process.ts;
    // whatever this returns is handed to it as providerEnv (explicit
    // credentials only). Ambient process.env is intentionally NOT spread —
    // that was the leak pattern this module exists to kill.
    const env = { ...extra };
    // Hand the settings-configured provider key to the env var of the
    // provider the chosen model belongs to ('anthropic/claude-…' →
    // ANTHROPIC_API_KEY). The spawned server never sees our ambient env,
    // so this explicit pass-through is the ONLY way a key reaches it.
    if (auth.authMode === 'apikey' && auth.apiKey) {
      const { keyVar, baseUrlVar } = providerEnvVars(auth.model ?? this.capabilities.defaultModel);
      env[keyVar] = auth.apiKey;
      if (auth.baseUrl) env[baseUrlVar] = auth.baseUrl;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'API key required' };
    }
    return { ok: true };
  }
}
