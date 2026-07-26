// terminal-cli-adapter.ts — generic interactive-CLI-TUI Worker backend.
//
// One skeleton, many CLIs: Claude Code, Kimi Code, Codex, Qoder all ship an
// interactive TUI that can run inside a PtyHost pty as a human-supervised
// Worker. The scheduler's first sendUserText() — the compiled task prompt —
// is "typed" into the TUI as a bracketed paste, and the user can take over
// the keyboard at any time through the stage terminal (ipc/worker-pty.ts).
//
// A TUI has no machine-readable output channel, so every terminal backend
// deliberately emits only a thin signal stream:
//   - a Stop hook (registered per-session by the profile) appends one JSON
//     line per finished turn; the session tails that file and emits a
//     `progress` signal carrying TERMINAL_TURN_ENDED_MARKER. It must NEVER
//     emit `ended(completed)` — that would trip the scheduler's missing-report
//     recovery and paste the recovery prompt into the TUI.
//   - task completion/failure is decided by the USER in the renderer confirm
//     bar; the scheduler synthesizes the WorkReport (delivery/failed signal)
//     outside this adapter.
//
// Per-CLI differences (binary resolution, hook registration, model/approval
// flags, managed config homes) live in a `TerminalCliProfile`. Hookless CLIs
// (qoder) omit `registerTurnHook` — the confirm bar is then the only
// turn-ended signal, which is the designed fallback anyway.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPtyHost, type PtyHost } from '../pty-host.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { compileBackendTaskProfile, type BackendRuntime } from './task-profile.js';
import {
  normalizeBackendPermissionRequest,
  type NativePermissionRequest,
  type PermissionNormalizationResult,
} from './canonical-execution.js';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  CliBackend,
  UserContentBlock,
} from './cli-backend.js';
import type {
  BackendEffectiveProfile,
  TaskExecutionProfile,
} from '../task-collaboration.js';

// ── Protocol constants (renderer mirrors these; keep stable) ────────────────

/** Prefix of the progress message emitted when the TUI finishes a turn
 *  (Stop hook). The renderer confirm bar keys on this marker. */
export const TERMINAL_TURN_ENDED_MARKER = '[terminal-turn-ended]';

export const TERMINAL_TURN_ENDED_MESSAGE =
  `${TERMINAL_TURN_ENDED_MARKER} 本轮对话已结束，等待人工确认：标记完成 / 继续指挥 / 标记失败。`;

/** Marker the terminal worker prints on its final reply when the task is
 *  fully done. The Stop hook scans the turn payload for this string and, on
 *  a hit, the adapter emits a completion progress (not a delivery) so the
 *  confirm bar lights up with a "task complete" prompt - the human reviews
 *  the TUI output and manually submits to the host. Must be distinct from
 *  TERMINAL_TURN_ENDED_MARKER, which fires every turn. */
export const TERMINAL_TASK_COMPLETE_MARKER = '[terminal-task-complete]';

export const TERMINAL_TASK_COMPLETE_MESSAGE =
  `${TERMINAL_TASK_COMPLETE_MARKER} 任务已完成，请查看上方输出并确认提交给 host。`;

/** Instruction appended to a terminal worker's first message telling it to
 *  emit the completion marker. Must live in the user prompt (firstMessage),
 *  not the system prompt - the TUI ignores systemPrompt. */
export const TERMINAL_WORKER_COMPLETION_INSTRUCTION =
  `\n\n任务全部完成时，在你最后一条回复里独占一行输出 ${TERMINAL_TASK_COMPLETE_MARKER}（只输出这个标记，不要加别的内容）。没完成绝不输出此标记。`;

/** Backend ids that run a human-supervised interactive TUI worker. The
 *  scheduler disables stall escalations for them and appends the completion
 *  instruction to their first message. */
export const TERMINAL_WORKER_BACKEND_IDS: ReadonlySet<string> = new Set([
  'claude-code-terminal',
  'kimi-code-terminal',
  'codex-terminal',
  'qoder-terminal',
]);

export function isTerminalWorkerBackend(backendId: string): boolean {
  return TERMINAL_WORKER_BACKEND_IDS.has(backendId);
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Bracketed-paste frame: the TUI treats the payload as one pasted block
 *  instead of interpreting newlines as submissions. The trailing \r that
 *  actually submits is written separately after a short settle delay. */
export function buildPasteFrame(text: string): string {
  return `${PASTE_START}${text}${PASTE_END}`;
}

/** Parse newly-appended turn-event lines. Fail-open per line: the hook file
 *  is append-only JSON-lines written by our own hook script, but a torn read
 *  mid-append must not break the tail loop. */
export function parseTurnEventLines(
  chunk: string,
): Array<{ kind: string; marker?: boolean; summary?: string }> {
  const events: Array<{ kind: string; marker?: boolean; summary?: string }> = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: unknown; marker?: unknown; summary?: unknown };
      if (typeof parsed.kind === 'string') {
        const event: { kind: string; marker?: boolean; summary?: string } = { kind: parsed.kind };
        if (typeof parsed.marker === 'boolean') event.marker = parsed.marker;
        if (typeof parsed.summary === 'string') event.summary = parsed.summary;
        events.push(event);
      }
    } catch { /* torn line — wait for the next change event */ }
  }
  return events;
}

/** Shared Stop-hook script (CJS, run via `ELECTRON_RUN_AS_NODE=1
 *  process.execPath`). Reads the hook payload on stdin, looks for the
 *  completion marker in the last assistant message, and appends one JSON
 *  line to the per-session events file. Field extraction is deliberately
 *  tolerant: Claude Code, Kimi Code and Codex all pass a JSON context whose
 *  exact key for the last assistant text differs (`last_assistant_message`,
 *  `lastMessage`, …); anything unrecognized degrades to "no marker", which
 *  just means the generic turn-ended prompt shows instead of the
 *  task-complete one. */
export function buildStopHookScript(eventsPath: string): string {
  return [
    '// AhaStation terminal-worker Stop hook (auto-generated, safe to delete)',
    '// Reads stdin (Stop hook payload), checks the last assistant message for',
    '// the completion marker, and records marker+summary so the host app can',
    '// light up the confirm bar.',
    "const fs = require('fs');",
    `const MARKER = ${JSON.stringify(TERMINAL_TASK_COMPLETE_MARKER)};`,
    "let last = '';",
    'try {',
    '  const obj = JSON.parse(fs.readFileSync(0, "utf8") || "{}");',
    '  const m = obj.last_assistant_message ?? obj.lastMessage ?? obj.last_message ?? "";',
    '  last = typeof m === "string" ? m : (m ? JSON.stringify(m) : "");',
    '} catch (e) { /* malformed stdin - treat as no marker */ }',
    'const hit = last.includes(MARKER);',
    `fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({ kind: 'stop', at: Date.now(), marker: hit, summary: hit ? last.slice(0, 20000) : '' }) + '\\n');`,
    '',
  ].join('\n');
}

// ── Profile ──────────────────────────────────────────────────────────────────

export interface TerminalCliHookRegistration {
  /** Extra CLI args that register the hook (e.g. ['--settings', file]). */
  cliArgs: string[];
  /** Extra env entries for the spawned pty (e.g. a managed config home). */
  env?: NodeJS.ProcessEnv;
  /** Files the profile created; removed on end(). */
  cleanupPaths: string[];
}

export interface TerminalCliProfile {
  /** Backend id, e.g. 'claude-code-terminal', 'kimi-code-terminal'. */
  id: string;
  capabilities: BackendCapabilities;
  /** Human label for progress/error messages, e.g. 'Claude', 'Kimi'. */
  displayLabel: string;
  /** Resolve the CLI binary; null = not installed. */
  resolveBinary: () => string | null;
  /** Extra CLI args beyond hook registration (model flag, approval flags). */
  buildCliArgs?(config: BackendSessionConfig): string[];
  /** Extra env entries beyond hook registration (managed config homes). */
  buildEnv?(config: BackendSessionConfig): NodeJS.ProcessEnv;
  /** Register the per-session Stop-hook plumbing. The skeleton has already
   *  created `ahaDir`, truncated `eventsPath` and written `hookScriptPath`;
   *  the profile only wires the hook command into the CLI's own config
   *  mechanism. Omit for hookless CLIs — the renderer confirm bar is then
   *  the only turn-ended signal (the designed manual fallback). */
  registerTurnHook?(ctx: {
    config: BackendSessionConfig;
    ahaDir: string;
    suffix: string;
    eventsPath: string;
    hookScriptPath: string;
    /** Shell-quoted hook command: `"<execPath>" "<hookScriptPath>"`. */
    hookCommand: string;
  }): TerminalCliHookRegistration;
  /** Progress message emitted right after spawn. */
  startupMessage: string;
  /** Failure message when the CLI binary is missing. */
  missingBinaryMessage: string;
  /** Key written to the pty on interrupt(). Default: Esc ('\x1b'). */
  interruptKey?: string;
  /** Map backend auth settings onto the subprocess env (api key, base url).
   *  Default: no auth mapping (the TUI owns login interactively). */
  applyAuth?(env: NodeJS.ProcessEnv, auth: BackendAuthConfig): void;
}

// ── Session ──────────────────────────────────────────────────────────────────

const READY_FALLBACK_MS = 5_000;
const READY_AFTER_FIRST_OUTPUT_MS = 1_600;
const SUBMIT_DELAY_MS = 150;

export interface TerminalCliSessionDeps {
  host: PtyHost;
  resolveBinary: () => string | null;
  /** Test seam: skip the ready delays. */
  timersEnabled?: boolean;
}

export class TerminalCliSession implements BackendSession {
  private readonly profile: TerminalCliProfile;
  private readonly config: BackendSessionConfig;
  private readonly emit: (e: BackendSessionEvent) => void;
  private readonly deps: TerminalCliSessionDeps;
  readonly workerId: string;
  private readonly ahaDir: string;
  private readonly suffix: string;
  private readonly hookScriptPath: string;
  private readonly eventsPath: string;
  private profileCleanupPaths: string[] = [];
  private ready = false;
  private closed = false;
  private started = false;
  private readonly pendingTexts: string[] = [];
  private watcher: FSWatcher | null = null;
  private eventsOffset = 0;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private firstOutputSeen = false;
  private unsubscribeData: (() => void) | null = null;
  private unsubscribeExit: (() => void) | null = null;

  constructor(
    profile: TerminalCliProfile,
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
    deps: TerminalCliSessionDeps,
  ) {
    this.profile = profile;
    this.config = config;
    this.emit = emit;
    this.deps = deps;
    const extraWorkerId = config.extra?.workerId;
    this.workerId = typeof extraWorkerId === 'string' && extraWorkerId.trim()
      ? extraWorkerId.trim()
      : `terminal-${randomUUID()}`;
    this.ahaDir = join(config.cwd, '.aha');
    this.suffix = this.workerId.replace(/[^a-zA-Z0-9._-]/g, '_');
    this.hookScriptPath = join(this.ahaDir, `terminal-stop-hook-${this.suffix}.cjs`);
    this.eventsPath = join(this.ahaDir, `terminal-turn-events-${this.suffix}.jsonl`);
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    const binary = this.deps.resolveBinary();
    if (!binary) {
      this.emit({
        kind: 'worker-signal',
        signal: {
          kind: 'failed',
          code: 'runtime-unavailable',
          message: this.profile.missingBinaryMessage,
          retryable: false,
        },
      });
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } });
      return;
    }

    // Stop hook plumbing: append-only events file + shared hook script.
    mkdirSync(this.ahaDir, { recursive: true });
    writeFileSync(this.eventsPath, '');
    this.eventsOffset = 0;
    writeFileSync(this.hookScriptPath, buildStopHookScript(this.eventsPath));
    this.profileCleanupPaths = [this.hookScriptPath, this.eventsPath];
    // process.execPath is Electron in the packaged app; ELECTRON_RUN_AS_NODE
    // (set on the pty env below) makes it act as plain node for the hook.
    const hookCommand = `"${process.execPath}" "${this.hookScriptPath}"`;
    const hookReg = this.profile.registerTurnHook?.({
      config: this.config,
      ahaDir: this.ahaDir,
      suffix: this.suffix,
      eventsPath: this.eventsPath,
      hookScriptPath: this.hookScriptPath,
      hookCommand,
    });
    if (hookReg) this.profileCleanupPaths.push(...hookReg.cleanupPaths);

    const env: NodeJS.ProcessEnv = {
      ...this.config.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...hookReg?.env,
      ...this.profile.buildEnv?.(this.config),
    };
    const cliArgs = [
      ...(hookReg?.cliArgs ?? []),
      ...(this.profile.buildCliArgs?.(this.config) ?? []),
    ];
    // .cmd/.bat shims (npm global install on Windows) are not directly
    // spawnable by ConPTY — route them through cmd.exe.
    const isWinShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
    const file = isWinShim ? 'cmd.exe' : binary;
    const args = isWinShim ? ['/d', '/s', '/c', binary, ...cliArgs] : cliArgs;

    this.deps.host.spawn(this.workerId, {
      file,
      args,
      cwd: this.config.cwd,
      env,
    });

    this.unsubscribeData = this.deps.host.onData(this.workerId, () => {
      if (this.firstOutputSeen || this.closed) return;
      this.firstOutputSeen = true;
      // The TUI draws its input box shortly after the first frame; give it a
      // beat before pasting so the prompt is not swallowed mid-init.
      this.scheduleReady(READY_AFTER_FIRST_OUTPUT_MS);
    });
    this.unsubscribeExit = this.deps.host.onExit(this.workerId, () => {
      if (this.closed) return;
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } });
    });
    // Fallback: paste anyway if the TUI stays quiet (e.g. output buffered).
    this.scheduleReady(READY_FALLBACK_MS, true);

    this.startTurnEventWatcher();
    this.emit({
      kind: 'worker-signal',
      signal: { kind: 'progress', message: this.profile.startupMessage },
    });
  }

  private scheduleReady(delayMs: number, fallback = false): void {
    if (this.ready || this.closed) return;
    if (this.readyTimer && !fallback) clearTimeout(this.readyTimer);
    else if (this.readyTimer && fallback) return; // first-output timer wins
    if (this.deps.timersEnabled === false) {
      this.markReady();
      return;
    }
    this.readyTimer = setTimeout(() => this.markReady(), delayMs);
    this.readyTimer.unref?.();
  }

  private markReady(): void {
    if (this.ready || this.closed) return;
    this.ready = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    for (const text of this.pendingTexts.splice(0)) this.pasteIntoTui(text);
  }

  private pasteIntoTui(text: string): void {
    if (this.closed) return;
    this.deps.host.write(this.workerId, buildPasteFrame(text));
    const submit = () => { this.deps.host.write(this.workerId, '\r'); };
    if (this.deps.timersEnabled === false) submit();
    else setTimeout(submit, SUBMIT_DELAY_MS).unref?.();
  }

  private startTurnEventWatcher(): void {
    try {
      this.watcher = watch(this.eventsPath, () => this.drainTurnEvents());
    } catch {
      // Watcher failure degrades to "no turn-ended signal" — the terminal
      // stays fully usable; the user just confirms without the marker.
      this.watcher = null;
    }
  }

  private drainTurnEvents(): void {
    if (this.closed) return;
    let content: string;
    try {
      content = readFileSync(this.eventsPath, 'utf8');
    } catch {
      return;
    }
    if (content.length <= this.eventsOffset) return;
    const chunk = content.slice(this.eventsOffset);
    this.eventsOffset = content.length;
    for (const event of parseTurnEventLines(chunk)) {
      if (event.kind !== 'stop') continue;
      if (event.marker) {
        // Completion marker hit: the worker declared the task done. Don't
        // auto-submit - emit a completion progress so the confirm bar lights
        // up with a "task complete" prompt. The human reviews the TUI output
        // and clicks "标记完成" to submit the WorkReport to the host (manual
        // submit). The TUI stays open until then.
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'progress', message: TERMINAL_TASK_COMPLETE_MESSAGE },
        });
      } else {
        // No marker: turn ended without a completion declaration; let the
        // human decide (confirm bar fallback).
        this.emit({
          kind: 'worker-signal',
          signal: { kind: 'progress', message: TERMINAL_TURN_ENDED_MESSAGE },
        });
      }
    }
  }

  sendUserText(text: string): void {
    if (this.closed || !text) return;
    if (!this.ready) {
      this.pendingTexts.push(text);
      return;
    }
    this.pasteIntoTui(text);
  }

  sendUserContent(content: UserContentBlock[]): void {
    const text = content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
    if (text) this.sendUserText(text);
  }

  resolvePermission(): void {
    // Permissions are answered by the human inside the TUI itself.
  }

  async interrupt(): Promise<void> {
    // Esc is the native "stop this turn" key for every supported TUI.
    this.deps.host.write(this.workerId, this.profile.interruptKey ?? '\x1b');
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.unsubscribeData?.();
    this.unsubscribeExit?.();
    try { this.watcher?.close(); } catch { /* already closed */ }
    this.watcher = null;
    this.deps.host.kill(this.workerId);
    // Cleanup paths may include per-session managed config homes (dirs).
    for (const path of this.profileCleanupPaths) {
      try { rmSync(path, { force: true, recursive: true }); } catch { /* best effort */ }
    }
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    return null;
  }
}

// ── Backend ──────────────────────────────────────────────────────────────────

export interface TerminalCliBackendDeps {
  resolveBinary?: () => string | null;
  host?: PtyHost;
  timersEnabled?: boolean;
}

export class TerminalCliBackend implements CliBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  protected readonly profile: TerminalCliProfile;
  private readonly deps: TerminalCliBackendDeps;

  constructor(profile: TerminalCliProfile, deps: TerminalCliBackendDeps = {}) {
    this.profile = profile;
    this.id = profile.id;
    this.capabilities = profile.capabilities;
    this.deps = deps;
  }

  compileTaskProfile(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile {
    return compileBackendTaskProfile(requested, runtime, {
      backendId: this.id,
      defaultModel: this.capabilities.defaultModel!,
      models: this.capabilities.models ?? [],
      // The TUI ignores mcp/systemPrompt/skills; surface that in the profile.
      unsupported: () => ['workMode'],
      downgraded: (profile) => [`workMode:${profile.workMode}->tui-interactive`],
    });
  }

  normalizePermissionRequest(
    native: NativePermissionRequest,
  ): PermissionNormalizationResult {
    // The TUI answers permissions itself (human at the terminal), so this
    // backend never emits native permission requests - but the scheduler's
    // validateExecutionBackends requires the method to exist. Delegate to the
    // shared normalizer for contract compliance.
    return normalizeBackendPermissionRequest(this.id, native);
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new TerminalCliSession(this.profile, config, emit, {
      host: this.deps.host ?? getPtyHost(),
      resolveBinary: () => this.resolveBinary(),
      timersEnabled: this.deps.timersEnabled,
    });
  }

  resolveBinary(): string | null {
    // An injected resolver (tests) is authoritative — even its null.
    if (this.deps.resolveBinary) return this.deps.resolveBinary();
    return this.profile.resolveBinary();
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // The interactive TUI must see the user's real environment (HOME with
    // the CLI's own OAuth credentials) — no shadow-home isolation here. The
    // orchestrator already restores the real HOME for non-claude-code ids.
    const env: NodeJS.ProcessEnv = { ...mergedSubprocessEnv() };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (typeof value === 'string') env[key] = value;
    }
    this.profile.applyAuth?.(env, auth);
    return env;
  }

  async validateAuth(): Promise<{ ok: boolean; error?: string }> {
    // Login state lives in the user's own CLI; the TUI prompts for auth
    // itself when needed, with the user right there to answer.
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // The interactive TUI owns authentication: when not logged in, the CLI
    // prompts for login itself while the user watches the terminal.
    // Reporting logged-in here keeps the backend selectable in the planner
    // (the backend-auth list otherwise gates it behind 'needs-login').
    return { loggedIn: true };
  }
}
