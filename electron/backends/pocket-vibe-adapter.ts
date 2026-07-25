// pocket-vibe-adapter.ts — pocket-vibe hub backend adapter.
//
// pocket-vibe is a REMOTE backend: there is no local CLI subprocess. A hub
// process (HTTP, default http://127.0.0.1:8787) fans turns out to agents
// registered on remote machines (Codex/Claude CLI on Windows/Mac/Linux).
// The hub exposes a polling-only API — no streaming events, no cancel:
//
//   GET  /health                 (unauthenticated)
//   GET  /v1/agents              (X-Pocket-Token)
//   POST /v1/turns               (X-Pocket-Token) → { ok, turn_id, task }
//   GET  /v1/turns/{turn_id}     (X-Pocket-Token) → { ok, task }
//
// task.status: queued | waiting_for_agent | sent | acked | done | failed.
// On done, task.result is the remote adapter's JSON (shape varies:
// json.last_message / stdout / note / objective / ... — extracted
// best-effort). On failed, task.error carries the summary.
//
// Worker contract: the remote agent has no AhaStation MCP, so the only
// completion channel is the fenced ```work-report JSON frame (the worker
// system prompt already instructs every backend to emit it — see
// WORKER_PROMPT in orchestrator-prompts.ts). This adapter mirrors the
// OpenCode worker pattern: status transitions → progress signals, turn end
// → exactly one strict WorkReport parse → delivery/failed + ended.

import type {
  BackendAuthConfig,
  BackendCapabilities,
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  CliBackend,
  InputPriority,
  UserContentBlock,
} from './cli-backend.js';
import {
  extractWorkReportFrame,
  type WorkerAdapterSignal,
} from '../worker-protocol.js';
import { getBackendAuth } from '../store.js';
import {
  compilePocketVibeTaskProfile,
  type BackendRuntime,
} from './task-profile.js';
import {
  normalizeBackendPermissionRequest,
  type NativePermissionRequest,
  type PermissionNormalizationResult,
} from './canonical-execution.js';
import type {
  BackendEffectiveProfile,
  TaskExecutionProfile,
} from '../task-collaboration.js';

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787';
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const HEALTH_TIMEOUT_MS = 5_000;

// ── Capabilities ────────────────────────────────────────────────────────────

const POCKET_VIBE_CAPABILITIES: BackendCapabilities = {
  // Host-capable via the portable meeting-command channel: like Codex, the
  // remote model emits fenced ```meeting-command JSON frames in its reply
  // text (taught by PORTABLE_MEETING_COMMAND_PROMPT, appended by
  // Orchestrator.buildSessionFactory) and this adapter routes them to
  // extra.meetingCommandHandler → Orchestrator.executeMeetingCommand.
  coordinate: true,
  executeTasks: true,
  displayName: 'Pocket Vibe (远程)',
  iconId: 'pocket-vibe',
  mcp: false,
  permissions: false,
  systemPrompt: true,
  skills: false,
  // Local interrupt stops polling; the hub has no cancel endpoint, so the
  // remote task may keep running (surfaced to the user on interrupt).
  interrupt: true,
  // The "model" slot doubles as the hub's target_agent_id fallback.
  defaultModel: 'linux-worker',
  models: ['linux-worker'],
  installHint: '启动 pocket-vibe hub（默认 http://127.0.0.1:8787）',
};

// ── Hub wire types (loose — the hub is an external process) ─────────────────

type HubTask = {
  status?: string;
  result?: unknown;
  error?: string;
  agent_id?: string;
};

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface PocketVibeDeps {
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  turnTimeoutMs?: number;
  healthTimeoutMs?: number;
}

/** Best-effort text extraction from a remote adapter's result JSON. */
export function extractPocketVibeResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  const r = result as Record<string, unknown>;
  const json = (r.json ?? undefined) as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    json?.last_message,
    r.last_message,
    r.stdout,
    r.note,
    r.text,
    r.output,
    r.message,
    r.objective,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  if (typeof r.error === 'string' && r.error.trim()) return r.error;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

class TurnInterrupted extends Error {
  constructor() {
    super('pocket-vibe turn interrupted');
    this.name = 'TurnInterrupted';
  }
}

/** Shown when a host turn contained only non-speak meeting commands, so the
 *  chat never goes silently blank (mirrors codex-adapter.ts). */
const COMMAND_ONLY_ACK = '我正在处理，有结果会马上告诉你。';

// ── Session implementation ──────────────────────────────────────────────────

class PocketVibeSession implements BackendSession {
  private closed = false;
  private ready = false;
  private firstTurn = true;
  private lastTurnId: string | null = null;
  private readonly sessionId: string | null;
  private readonly hubUrl: string;
  private readonly token: string;
  private readonly targetAgentId: string | undefined;
  private readonly provider: string | undefined;
  private readonly turnOptions: Record<string, unknown> | undefined;
  private readonly pollIntervalMs: number;
  private readonly turnTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  // Serial turn queue — one hub turn in flight at a time.
  private queue: string[] = [];
  private pumping = false;
  private turnAbort: AbortController | null = null;
  private lastEmittedStatus: string | null = null;
  private meetingCommandHandler?: (command: unknown) => Promise<unknown> | unknown;

  private get isWorker(): boolean {
    return this.config.executionRole === 'worker';
  }

  constructor(
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
    deps: PocketVibeDeps = {},
  ) {
    const env = config.env ?? {};
    this.hubUrl = (env.POCKET_VIBE_HUB_URL ?? '').trim() || DEFAULT_HUB_URL;
    this.token = (env.POCKET_VIBE_TOOL_TOKEN ?? '').trim();
    this.targetAgentId = (env.POCKET_VIBE_AGENT_ID ?? '').trim()
      || config.model
      || undefined;
    this.provider = (env.POCKET_VIBE_PROVIDER ?? '').trim() || undefined;
    // Session continuity: when POCKET_VIBE_SESSION_ID (or a journal-provided
    // resumeSessionId) is set, the hub RESUMES the remote agent session so
    // conversational context survives across turns. Without it every turn is
    // a fresh remote exec with no memory — see the system-prompt replay rule
    // in runTurn().
    this.sessionId = (env.POCKET_VIBE_SESSION_ID ?? '').trim()
      || config.resumeSessionId
      || null;
    this.turnOptions = parseJsonObject(env.POCKET_VIBE_TURN_OPTIONS);
    this.pollIntervalMs = deps.pollIntervalMs
      ?? parsePositiveInt(env.POCKET_VIBE_POLL_INTERVAL_MS)
      ?? DEFAULT_POLL_INTERVAL_MS;
    this.turnTimeoutMs = deps.turnTimeoutMs
      ?? parsePositiveInt(env.POCKET_VIBE_TURN_TIMEOUT_MS)
      ?? DEFAULT_TURN_TIMEOUT_MS;
    this.fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    this.healthTimeoutMs = deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    const handler = config.extra?.meetingCommandHandler;
    if (typeof handler === 'function') {
      this.meetingCommandHandler = handler as (command: unknown) => Promise<unknown> | unknown;
    }
  }

  private readonly healthTimeoutMs: number;

  async start(): Promise<void> {
    // 1. Hub reachability. Host mode fails FAST with a legible reason —
    //    otherwise HostGroup only sees the session go dark and reports the
    //    cryptic "ended before readiness".
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.healthTimeoutMs);
      let res;
      try {
        res = await this.fetchImpl(`${this.hubUrl}/health`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        throw new Error(`hub /health HTTP ${res.status}`);
      }
    } catch (err) {
      const message = `Pocket Vibe hub 不可达（${this.hubUrl}）：${String(err)}`;
      if (this.isWorker) {
        this.emitFailure('pocket-vibe-hub-unreachable', message, true);
        return;
      }
      this.emit({ kind: 'error', error: message });
      throw new Error(message);
    }

    // 2. Token must exist and be accepted. A missing token would 401 every
    //    /v1/* call later, so fail at startup instead of turn-by-turn.
    if (!this.token) {
      const message = 'Pocket Vibe 未配置 tool token：请在 设置 → Pocket Vibe (远程) 的 API Key 栏填入 hub 的 tool token 并保存（回车或点保存按钮）。';
      if (this.isWorker) {
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'failed', code: 'pocket-vibe-auth', message, retryable: false },
        });
        return;
      }
      this.emit({ kind: 'auth-required', error: message });
      throw new Error(message);
    }
    const agents = await this.fetchImpl(`${this.hubUrl}/v1/agents`, {
      headers: this.authHeaders(),
    }).catch(() => null);
    if (agents && (agents.status === 401 || agents.status === 403)) {
      const message = 'Pocket Vibe tool token 被 hub 拒绝（401/403），请在设置中检查 token。';
      if (this.isWorker) {
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'failed', code: 'pocket-vibe-auth', message, retryable: false },
        });
        return;
      }
      this.emit({ kind: 'auth-required', error: message });
      throw new Error(message);
    }

    this.ready = true;
    this.emitInformational(`Pocket Vibe 已连接 hub ${this.hubUrl}`);
  }

  // ── Turn pipeline ─────────────────────────────────────────────────────────

  sendUserText(text: string, _priority?: InputPriority): void {
    if (this.closed || !this.ready) return;
    this.queue.push(text);
    void this.pump();
  }

  sendUserContent(content: string | UserContentBlock[], priority?: InputPriority): void {
    if (typeof content === 'string') {
      this.sendUserText(content, priority);
      return;
    }
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    if (text) this.sendUserText(text, priority);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.closed) {
        const text = this.queue.shift()!;
        try {
          await this.runTurn(text);
        } catch (err) {
          // TurnInterrupted (sleep) and AbortError (in-flight fetch) both
          // mean interrupt() fired — interrupt() already emitted the
          // terminal signal, so just move on to the next queued turn.
          if (err instanceof TurnInterrupted || isAbortError(err)) continue;
          if (this.closed) return;
          this.emitFailure(
            'pocket-vibe-turn-error',
            `Pocket Vibe turn 失败：${String(err)}`,
            true,
          );
          if (this.isWorker) {
            this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async runTurn(text: string): Promise<void> {
    // The hub has no system-prompt field, so the contract (work-report frame
    // for workers, meeting-command protocol for hosts) travels inside the
    // prompt text. With session continuity configured (POCKET_VIBE_SESSION_ID
    // / resumeSessionId) the hub resumes the remote session and prior
    // context survives — prepend once. Without it EVERY turn is a fresh
    // remote exec with no memory, so the full system prompt must be replayed
    // on every turn or the remote agent loses the protocol instructions.
    const needsSystemPrompt = this.config.systemPrompt
      && (this.firstTurn || !this.sessionId);
    const prompt = needsSystemPrompt
      ? `${this.config.systemPrompt}\n\n${text}`
      : text;
    this.firstTurn = false;

    const body: Record<string, unknown> = {
      prompt,
      cwd: this.config.cwd,
      metadata: { source: 'ahastation' },
    };
    if (this.targetAgentId) body.target_agent_id = this.targetAgentId;
    if (this.provider) body.provider = this.provider;
    if (this.sessionId) body.session_id = this.sessionId;
    if (this.turnOptions) body.turn_options = this.turnOptions;

    const created = await this.fetchImpl(`${this.hubUrl}/v1/turns`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!created.ok) {
      throw new Error(`POST /v1/turns HTTP ${created.status}: ${await created.text().catch(() => '')}`);
    }
    const payload = (await created.json()) as { ok?: boolean; turn_id?: string; task?: HubTask };
    if (!payload.ok || typeof payload.turn_id !== 'string' || !payload.turn_id) {
      throw new Error('POST /v1/turns 返回缺少 turn_id');
    }
    const turnId = payload.turn_id;
    this.lastTurnId = turnId;
    this.lastEmittedStatus = null;

    const agentLabel = this.targetAgentId ?? '（自动分配）';
    this.emitProgress(`任务已发送到远程 agent ${agentLabel}（turn ${turnId.slice(0, 8)}…）`);
    this.noteStatus(payload.task?.status);

    const abort = new AbortController();
    this.turnAbort = abort;
    const deadline = Date.now() + this.turnTimeoutMs;
    try {
      for (;;) {
        await sleep(this.pollIntervalMs, abort.signal);
        const res = await this.fetchImpl(
          `${this.hubUrl}/v1/turns/${encodeURIComponent(turnId)}`,
          { headers: this.authHeaders(), signal: abort.signal },
        );
        if (!res.ok) {
          // Transient hub hiccup — keep polling until the deadline.
          if (Date.now() >= deadline) break;
          continue;
        }
        const task = ((await res.json()) as { task?: HubTask }).task ?? {};
        this.noteStatus(task.status);
        if (task.status === 'done') {
          this.finishDoneTurn(task);
          return;
        }
        if (task.status === 'failed') {
          this.finishFailedTurn(task);
          return;
        }
        if (Date.now() >= deadline) break;
      }
      // Poll deadline exhausted.
      const message = `Pocket Vibe turn ${turnId.slice(0, 8)}… 超过 ${Math.round(this.turnTimeoutMs / 1000)}s 未完成`;
      if (this.isWorker) {
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'failed', code: 'pocket-vibe-turn-timeout', message, retryable: true },
        });
        this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
      } else {
        this.emit({ kind: 'error', error: message });
      }
    } finally {
      if (this.turnAbort === abort) this.turnAbort = null;
    }
  }

  /** Emit a progress note only when the hub status actually changes. */
  private noteStatus(status: string | undefined): void {
    if (!status || status === this.lastEmittedStatus) return;
    this.lastEmittedStatus = status;
    const label: Record<string, string> = {
      queued: '排队中',
      waiting_for_agent: '等待远程 agent 接收',
      sent: '已发送到远程 agent',
      acked: '远程 agent 已确认，执行中',
    };
    const text = label[status];
    if (text) this.emitProgress(`Pocket Vibe：${text}`);
  }

  private finishDoneTurn(task: HubTask): void {
    const text = extractPocketVibeResultText(task.result);
    if (this.isWorker) {
      const extracted = extractWorkReportFrame(text);
      if (extracted.visibleText) {
        this.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: extracted.visibleText } });
      }
      const signals: WorkerAdapterSignal[] = extracted.report
        ? [
            { kind: 'delivery', report: extracted.report },
            { kind: 'ended', reason: 'completed' },
          ]
        : [
            {
              kind: 'failed',
              code: extracted.error ? 'invalid-work-report' : 'missing-work-report',
              message: extracted.error
                ? `Pocket Vibe 返回了非法 WorkReport：${extracted.error}`
                : 'Pocket Vibe turn 结束但没有 WorkReport',
              retryable: true,
            },
            { kind: 'ended', reason: 'completed' },
          ];
      for (const signal of signals) {
        this.emit({ kind: 'worker-signal', signal });
      }
      return;
    }
    const visible = extractWorkReportFrame(text).visibleText;
    // Host path: dispatch fenced ```meeting-command frames to the
    // orchestrator exactly like the Codex host path (PORTABLE_MEETING_COMMAND_PROMPT
    // teaches the remote model the protocol), then emit whatever text
    // remains as the assistant message.
    const { visibleText, hasSpeakCommand, hasNonSpeakCommand } =
      this.dispatchMeetingCommands(visible);
    // `speak` is rendered by Orchestrator.narrateAssistantLine() — emitting
    // the agent message too would double the sentence in the transcript.
    if (!hasSpeakCommand) {
      const chatText = visibleText || (hasNonSpeakCommand ? COMMAND_ONLY_ACK : '');
      if (chatText) {
        this.emit({
          kind: 'message',
          message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: chatText }] },
          },
        });
      }
    }
    this.emit({ kind: 'message', message: { type: 'result', raw: task } });
  }

  /** Extract fenced ```meeting-command frames, hand each parsed command to
   *  the orchestrator's handler (fire-and-forget; handler errors surface as
   *  session error events) and return the remaining user-visible text.
   *  Mirrors dispatchAppServerCommands in codex-adapter.ts. */
  private dispatchMeetingCommands(text: string): {
    visibleText: string; hasSpeakCommand: boolean; hasNonSpeakCommand: boolean;
  } {
    const fenced = /```meeting-command\s*([\s\S]*?)```/gi;
    let hasSpeakCommand = false;
    let hasNonSpeakCommand = false;
    for (const match of text.matchAll(fenced)) {
      try {
        const command = JSON.parse(match[1]);
        if (
          command?.kind === 'speak'
          && typeof command.text === 'string'
          && command.text.trim().length > 0
        ) hasSpeakCommand = true;
        else hasNonSpeakCommand = true;
        if (this.meetingCommandHandler) {
          void Promise.resolve(this.meetingCommandHandler(command)).catch((err) => {
            this.emit({ kind: 'error', error: `Meeting command failed: ${String(err)}` });
          });
        }
      } catch (err) {
        this.emit({ kind: 'error', error: `Invalid meeting-command JSON: ${String(err)}` });
      }
    }
    return {
      visibleText: text.replace(fenced, '').trim(),
      hasSpeakCommand,
      hasNonSpeakCommand,
    };
  }

  private finishFailedTurn(task: HubTask): void {
    const detail = (typeof task.error === 'string' && task.error.trim())
      ? task.error
      : extractPocketVibeResultText(task.result) || '远程任务失败（无错误详情）';
    if (this.isWorker) {
      this.emit({
        kind: 'worker-signal',
        signal: {
          kind: 'failed',
          code: 'pocket-vibe-turn-failed',
          message: `Pocket Vibe 远程任务失败：${detail}`,
          retryable: true,
        },
      });
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
      return;
    }
    this.emit({
      kind: 'message',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `Pocket Vibe 远程任务失败：${detail}` }],
        },
      },
    });
    this.emit({ kind: 'message', message: { type: 'result', raw: task } });
  }

  // ── Emit helpers (mirror the OpenCode worker/host split) ─────────────────

  private emitProgress(text: string): void {
    if (this.closed) return;
    if (this.isWorker) {
      this.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: text } });
      return;
    }
    this.emit({
      kind: 'message',
      message: {
        type: 'system',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      },
    });
  }

  private emitInformational(text: string): void {
    this.emitProgress(text);
  }

  private emitFailure(code: string, message: string, retryable: boolean): void {
    if (this.closed) return;
    if (this.isWorker) {
      this.emit({ kind: 'worker-signal', signal: { kind: 'failed', code, message, retryable } });
      return;
    }
    this.emit({ kind: 'error', error: message });
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { 'X-Pocket-Token': this.token } : {};
  }

  // ── BackendSession contract ───────────────────────────────────────────────

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // permissions: false — the hub runs the remote CLI under its own policy.
  }

  async interrupt(reason: 'steer' | 'user' | 'shutdown' = 'user'): Promise<void> {
    if (this.closed) return;
    const hadTurn = this.turnAbort !== null;
    this.turnAbort?.abort();
    this.turnAbort = null;
    if (!hadTurn) return;
    if (this.isWorker) {
      if (reason !== 'steer') {
        this.emit({
          kind: 'worker-signal',
          signal: {
            kind: 'progress',
            message: '已停止等待远程结果（hub 无取消接口，远程任务可能仍在运行）',
          },
        });
        this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
      }
      return;
    }
    if (reason !== 'steer') {
      this.emitInformational('已中断等待（hub 无取消接口，远程任务可能仍在运行）。');
    }
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    const id = this.sessionId ?? this.lastTurnId;
    return id ? { protocol: 'pocket-vibe', sessionId: id } : null;
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.turnAbort?.abort();
    this.turnAbort = null;
    this.emit({ kind: 'ended' });
    this.emit = () => {};
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TurnInterrupted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// ── Backend factory ─────────────────────────────────────────────────────────

export class PocketVibeBackend implements CliBackend {
  readonly id = 'pocket-vibe';
  readonly capabilities = POCKET_VIBE_CAPABILITIES;

  constructor(private readonly deps: PocketVibeDeps = {}) {}

  compileTaskProfile(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile {
    return compilePocketVibeTaskProfile(
      requested,
      runtime,
      this.capabilities.defaultModel!,
    );
  }

  normalizePermissionRequest(
    native: NativePermissionRequest,
  ): PermissionNormalizationResult {
    // capabilities.permissions is false so no native request ever arrives;
    // the orchestrator's plan gate still requires this method to exist.
    return normalizeBackendPermissionRequest(this.id, native);
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new PocketVibeSession(config, emit, this.deps);
  }

  resolveBinary(): string | null {
    // Remote backend — no local binary exists. The registry treats a null
    // return as "not installed" and hides the backend from the UI, so a
    // non-null sentinel marks this always-available HTTP backend.
    return 'pocket-vibe-remote';
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...extra };
    if (auth.baseUrl) env.POCKET_VIBE_HUB_URL = auth.baseUrl;
    if (auth.authMode === 'apikey' && auth.apiKey) {
      env.POCKET_VIBE_TOOL_TOKEN = auth.apiKey;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'Tool token required' };
    }
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // The SideDrawer "邀请" gate (isConfigured = loggedIn) only trusts
    // checkAuthStatus — without it a saved tool token still showed "未配置".
    // A stored tool token is sufficient: the hub is a LAN service, and the
    // token is validated for real when a session starts (401 → auth-required).
    const auth = getBackendAuth(this.id);
    return { loggedIn: Boolean(auth?.apiKey?.trim()) };
  }
}
