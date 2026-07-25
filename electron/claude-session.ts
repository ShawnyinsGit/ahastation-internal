import {
  query as defaultQuery,
  type ClaudeCliQuery,
  type ClaudeCliQueryFactory,
} from './claude-cli/driver.js';
import type {
  CanUseTool,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
  SessionOptions,
} from './claude-cli/types.js';
import { mergedSubprocessEnv } from './settings-loader.js';
import { errorMessage, redactSecrets } from './format-error.js';
import { classifyToolRisk, type AutoApproveScope } from './auto-approve-policy.js';
import { randomUUID } from 'node:crypto';
import type { WorkerAdapterSignal } from './worker-protocol.js';

function isClaudeAuthError(message: string): boolean {
  return /authentication[_\s-]?failed|unauthorized|\b401\b|please (?:log|sign) in|auth(?:entication)? required/i.test(message);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type PermissionPending = {
  resolve: (r: PermissionResult) => void;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
};

export type SessionEvent =
  | { kind: 'message'; message: SDKMessage }
  | { kind: 'worker-signal'; signal: WorkerAdapterSignal }
  | { kind: 'permission-request'; id: string; toolName: string; input: Record<string, unknown>; toolUseID: string }
  | { kind: 'auth-required'; error: string }
  | { kind: 'error'; error: string }
  | { kind: 'ended' };

/** Priority for input messages handed to the talker.
 *   high   → real user voice / typed text from the renderer
 *   normal → system-synthesised lines (greetings, narrate, decision updates)
 *   low    → worker progress / collision / task_done broadcasts
 *
 *  The session drains all 'high' messages before any 'normal', and all
 *  'normal' before any 'low'. This way a long burst of worker chatter cannot
 *  push the user's next utterance to the back of the queue. */
export type InputPriority = 'high' | 'normal' | 'low';

/** Native confirmer for destructive tool calls when auto-approve is on. The
 *  Electron implementation lives in main.ts and calls dialog.showMessageBox;
 *  resolves true on Allow, false on Deny. */
export type ConfirmDestructive = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<boolean>;

export class ClaudeSession {
  private q: ClaudeCliQuery | null = null;
  // Three FIFO buckets, drained strictly high → normal → low so worker
  // progress can never starve a user utterance. See InputPriority for why.
  private highQueue: SDKUserMessage[] = [];
  private normalQueue: SDKUserMessage[] = [];
  private lowQueue: SDKUserMessage[] = [];
  private inputResolvers: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;
  private pendingPerms = new Map<string, PermissionPending>();
  private emit: (e: SessionEvent) => void;
  private cwd: string;
  private sessionOptions: SessionOptions;
  private envOverride: NodeJS.ProcessEnv | undefined;
  // Trust-mode scope. Controls which tools are silently approved:
  //   'off'  → all tools go through the permission flow (default)
  //   'read' → only safe/read tools auto-approved, destructive still escalate
  //   'all'  → all tools auto-approved including Write/Bash (no prompt)
  // Toggled live by the orchestrator. Default OFF — never enabled silently.
  private autoApproveScope: AutoApproveScope = 'off';
  private confirmDestructive: ConfirmDestructive | undefined;
  // Ring buffer of recent CLI stderr lines. The SDK reports unclassifiable API
  // failures as bare codes ('unknown'); the human-readable HTTP error only
  // appears on the subprocess stderr, which we capture here so it can be
  // attached to the failing assistant message and shown in the renderer.
  private stderrRing: string[] = [];
  private authRequiredEmitted = false;
  private queryFactory: ClaudeCliQueryFactory;
  private sessionId: string | null = null;

  constructor(opts: {
    emit: (e: SessionEvent) => void;
    cwd: string;
    sessionOptions?: SessionOptions;
    autoApproveScope?: AutoApproveScope;
    /** Process env to feed into the worker subprocess. Overrides
     *  mergedSubprocessEnv() — used to redirect HOME at the merged
     *  bundled+user `.claude` shadow dir. */
    envOverride?: NodeJS.ProcessEnv;
    /** Native OS confirmer for destructive tool calls under auto-approve. In
     *  Electron, wired to dialog.showMessageBox so a compromised renderer
     *  cannot fake the approval. If omitted (tests, non-Electron contexts)
     *  destructive tools under auto-approve fall back to the renderer
     *  permission-request path. */
    confirmDestructive?: ConfirmDestructive;
    /** Test/runtime seam for the CLI query constructor. */
    queryFactory?: ClaudeCliQueryFactory;
  }) {
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.sessionOptions = opts.sessionOptions ?? {};
    this.autoApproveScope = opts.autoApproveScope ?? 'off';
    this.envOverride = opts.envOverride;
    this.confirmDestructive = opts.confirmDestructive;
    this.queryFactory = opts.queryFactory ?? defaultQuery;
  }

  /** Toggle auto-approve scope live. Affects subsequent canUseTool calls only. */
  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
  }

  async start(): Promise<void> {
    if (this.q) return;
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (this.closed) {
        return { behavior: 'deny', message: 'session ended', interrupt: true };
      }
      if (this.autoApproveScope !== 'off') {
        // 'all' scope: most tools auto-approved, but ALWAYS_DESTRUCTIVE
        // tools (e.g. browser_evaluate) still require native OS confirmation.
        if (this.autoApproveScope === 'all') {
          if (classifyToolRisk(toolName) !== 'destructive') {
            return { behavior: 'allow', updatedInput: input };
          }
          // Destructive tool under 'all' — fall through to confirmDestructive.
        }
        // 'read' scope: only safe tools auto-approved; destructive ones escalate.
        if (this.autoApproveScope === 'read' && classifyToolRisk(toolName) === 'safe') {
          return { behavior: 'allow', updatedInput: input };
        }
        if (this.confirmDestructive) {
          if (this.closed) {
            return { behavior: 'deny', message: 'session ended', interrupt: true };
          }
          const allowed = await this.confirmDestructive(toolName, input);
          if (this.closed) {
            return { behavior: 'deny', message: 'session ended', interrupt: true };
          }
          return allowed
            ? { behavior: 'allow', updatedInput: input }
            : {
                behavior: 'deny',
                message: 'User denied this destructive tool call (auto-approve native confirm).',
                interrupt: false,
              };
        }
        // No native confirmer available — degrade to the standard prompt path
        // below rather than auto-allowing a destructive call.
      }
      return new Promise<PermissionResult>((resolve) => {
        const id = randomUUID();
        this.pendingPerms.set(id, { resolve, toolName, input, toolUseID: options.toolUseID });
        this.emit({ kind: 'permission-request', id, toolName, input, toolUseID: options.toolUseID });
      });
    };

    try {
      // The driver resolves the user's local claude CLI itself and throws
      // synchronously when it is missing — the catch below reports that the
      // same way the old bundled-binary check did.
      this.q = this.queryFactory({
        prompt: this.createInputIterable(),
        options: {
          cwd: this.cwd,
          canUseTool,
          permissionMode: 'default',
          env: this.envOverride ?? mergedSubprocessEnv(),
          stderr: (data: string) => {
            // Redact at the source so the ring, the derived errorDetail, and
            // this log line can never carry the API key / auth headers (the
            // gateway or a debug-logging CLI may echo them on failure).
            const safe = redactSecrets(data);
            this.stderrRing.push(safe);
            if (this.stderrRing.length > 40) this.stderrRing.shift();
            console.error('[claude-cli:stderr]', safe);
          },
          // Load user/project/local settings so the worker picks up the
          // developer's installed subagents (~/.claude/agents/*.md), hooks
          // (~/.claude/settings.json → hooks), and MCP servers — and, above
          // all, the user's own ~/.claude login state.
          settingSources: ['user', 'project', 'local'],
          // Skills are NOT auto-enabled by settingSources — omitting `skills`
          // means "CLI defaults apply", which in embedded stream-json mode is
          // off. 'all' opts every discovered skill in (both user-level and
          // plugin-qualified). Talker overrides this with `skills: []` since
          // it has no real tools.
          skills: 'all',
          ...this.sessionOptions,
        },
      });
    } catch (err: unknown) {
      const detail = errorMessage(err);
      if (isClaudeAuthError(detail)) this.emitAuthRequired();
      else this.emit({ kind: 'error', error: `claude CLI init failed: ${detail}` });
      this.emit({ kind: 'ended' });
      throw err;
    }

    (async () => {
      try {
        for await (const msg of this.q!) {
          if (this.closed) break;
          const nativeSessionId = (msg as { session_id?: unknown }).session_id;
          if (typeof nativeSessionId === 'string' && nativeSessionId.length > 0) {
            this.sessionId = nativeSessionId;
          }
          // Surface API-level failures the SDK couldn't classify ('unknown' et
          // al.). The renderer only gets the short code; the real cause lives in
          // request_id + message content, which we log here so a terminal-
          // launched build can be diagnosed.
          const errCode = (msg as { error?: unknown })?.error;
          if (typeof errCode === 'string' && errCode.length > 0) {
            const rid = (msg as { request_id?: unknown }).request_id;
            console.error(
              `[claude-session] assistant API error code=${errCode}`,
              `request_id=${typeof rid === 'string' ? rid : 'n/a'}`,
              JSON.stringify((msg as { message?: unknown }).message ?? null).slice(0, 800),
            );
            // Attach the captured stderr tail so the renderer can show the real
            // HTTP error instead of a bare 'unknown' code.
            const detail = this.stderrRing.join('').slice(-2000).trim();
            if (detail.length > 0) {
              (msg as { errorDetail?: string }).errorDetail = detail;
            }
            if (isClaudeAuthError(`${errCode} ${detail}`)) {
              this.emitAuthRequired();
              break;
            }
          }
          this.emit({ kind: 'message', message: msg });
        }
      } catch (err: unknown) {
        if (!this.closed) {
          const detail = errorMessage(err);
          if (isClaudeAuthError(detail)) this.emitAuthRequired();
          else this.emit({ kind: 'error', error: detail });
        }
      } finally {
        // Deny all pending permissions so workers don't hang waiting for a
        // response that will never come (e.g. if the SDK stream crashed).
        for (const [, p] of this.pendingPerms) {
          try { p.resolve({ behavior: 'deny', message: 'session crashed', interrupt: true }); } catch { /* ignore */ }
        }
        this.pendingPerms.clear();
        this.emit({ kind: 'ended' });
        // Drop the closure-captured emit so any lingering SDK callbacks (e.g.
        // late tool_result, post-interrupt error) can't pollute the next session.
        this.emit = () => {};
      }
    })();

    try {
      const initialization = await withTimeout(
        this.q.initializationResult(), 15_000, 'Claude CLI readiness handshake timed out',
      );
      const account = initialization.account;
      if (
        account?.apiProvider === 'firstParty'
        && (account.tokenSource === 'none' || account.tokenSource === undefined)
        && !account.apiKeySource
        && !account.email
        && !account.subscriptionType
      ) {
        this.emitAuthRequired();
        throw new Error('Claude authentication required');
      }
    } catch (err) {
      const detail = errorMessage(err);
      if (isClaudeAuthError(detail)) this.emitAuthRequired();
      else if (!this.closed) this.emit({ kind: 'error', error: detail });
      await this.q?.interrupt().catch(() => undefined);
      throw err;
    }
  }

  private emitAuthRequired(): void {
    if (this.authRequiredEmitted) return;
    this.authRequiredEmitted = true;
    this.emit({ kind: 'auth-required', error: 'Claude 登录已失效，请完成重新认证后重连 Host。' });
  }

  sendUserText(text: string, priority: InputPriority = 'normal') {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    this.pushInput(msg, priority);
  }

  sendUserContent(content: SDKUserMessage['message']['content'], priority: InputPriority = 'normal') {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
    this.pushInput(msg, priority);
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string) {
    const pending = this.pendingPerms.get(id);
    if (!pending) return;
    this.pendingPerms.delete(id);
    if (decision === 'allow') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
    } else {
      pending.resolve({ behavior: 'deny', message: message ?? 'User denied this tool call.', interrupt: false });
    }
  }

  async interrupt() {
    if (this.q) {
      try { await this.q.interrupt(); } catch (err) {
        console.warn('[claude-session] interrupt failed:', err);
      }
    }
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    if (this.q) {
      try { await this.q.setPermissionMode(mode); } catch (err) {
        console.warn('[claude-session] setPermissionMode failed:', err);
      }
    }
  }

  end() {
    if (this.closed) return;
    this.closed = true;

    // Resolve any in-flight permission requests as deny+interrupt so the SDK's
    // CanUseTool promise never hangs (which would orphan the subprocess).
    for (const [id, p] of this.pendingPerms) {
      try { p.resolve({ behavior: 'deny', message: 'session ended', interrupt: true }); } catch { /* ignore */ }
      this.pendingPerms.delete(id);
    }

    // Wake up the input iterator so the for-await loop exits.
    while (this.inputResolvers.length > 0) {
      const r = this.inputResolvers.shift();
      r?.({ value: undefined as any, done: true });
    }

    // Tell the CLI to stop streaming, then kill the process — end() is a
    // teardown path and the child must not linger with stdin held open.
    if (this.q) {
      this.q.interrupt().catch(() => { /* ignore */ });
      try { this.q.close(); } catch { /* ignore */ }
    }
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    return this.sessionId
      ? { protocol: 'claude-cli', sessionId: this.sessionId }
      : null;
  }

  private pushInput(m: SDKUserMessage, priority: InputPriority) {
    if (this.closed) return;
    // A waiting resolver always wins over queueing — but only when there's
    // nothing already buffered ahead of this priority. The picker below is
    // strict (high → normal → low), so for a fresh resolver we can hand the
    // message off directly regardless of priority since all queues are empty.
    if (this.highQueue.length === 0 && this.normalQueue.length === 0 && this.lowQueue.length === 0) {
      const r = this.inputResolvers.shift();
      if (r) {
        r({ value: m, done: false });
        return;
      }
    }
    if (priority === 'high') this.highQueue.push(m);
    else if (priority === 'low') this.lowQueue.push(m);
    else this.normalQueue.push(m);
  }

  private dequeueNext(): SDKUserMessage | undefined {
    if (this.highQueue.length > 0) return this.highQueue.shift();
    if (this.normalQueue.length > 0) return this.normalQueue.shift();
    if (this.lowQueue.length > 0) return this.lowQueue.shift();
    return undefined;
  }

  private createInputIterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            const next = self.dequeueNext();
            if (next !== undefined) {
              return Promise.resolve({ value: next, done: false });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined as any, done: true });
            }
            return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              self.inputResolvers.push(resolve);
            });
          },
        };
      },
    };
  }
}
