// claude-terminal-adapter.ts — interactive `claude` TUI as a Worker backend.
//
// Unlike claude-code-adapter (headless SDK), this backend runs the user's own
// interactive Claude Code CLI inside a PtyHost pty. The scheduler's
// first sendUserText() — the compiled task prompt — is "typed" into the TUI
// as a bracketed paste, and the user can take over the keyboard at any time
// through the stage terminal (ipc/worker-pty.ts).
//
// The TUI has no machine-readable output channel, so this adapter deliberately
// emits only a thin signal stream:
//   - a Stop hook (written into a per-session --settings file) appends one
//     JSON line per finished turn; the adapter tails that file and emits a
//     `progress` signal carrying TERMINAL_TURN_ENDED_MARKER. It must NEVER
//     emit `ended(completed)` — that would trip the scheduler's missing-report
//     recovery and paste the recovery prompt into the TUI.
//   - task completion/failure is decided by the USER in the renderer confirm
//     bar; the scheduler synthesizes the WorkReport (delivery/failed signal)
//     outside this adapter.

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
import { mergedSubprocessEnv } from '../settings-loader.js';
import { resolveClaudeBinaryForSource } from '../claude-cli/resolve.js';
import { getPtyHost, type PtyHost } from '../pty-host.js';
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

// ── Protocol constants (exported for renderer mirroring + tests) ────────────

/** Prefix of the progress message emitted when the Claude TUI finishes a
 *  turn (Stop hook). The renderer confirm bar keys on this marker. */
export const TERMINAL_TURN_ENDED_MARKER = '[terminal-turn-ended]';

export const TERMINAL_TURN_ENDED_MESSAGE =
  `${TERMINAL_TURN_ENDED_MARKER} 本轮对话已结束，等待人工确认：标记完成 / 继续指挥 / 标记失败。`;

/** Marker the terminal worker prints on its final reply when the task is
 *  fully done. The Stop hook scans stdin `last_assistant_message` for this
 *  string and, on a hit, the adapter emits a `delivery` signal
 *  (auto-completion) instead of the turn-ended progress (which only asks the
 *  human to confirm). Must be distinct from TERMINAL_TURN_ENDED_MARKER, which
 *  fires every turn. */
export const TERMINAL_TASK_COMPLETE_MARKER = '[terminal-task-complete]';

/** Instruction appended to a terminal worker's first message telling it to
 *  emit the completion marker. Must live in the user prompt (firstMessage),
 *  not the system prompt - the TUI ignores systemPrompt. */
export const TERMINAL_WORKER_COMPLETION_INSTRUCTION =
  `\n\n任务全部完成时，在你最后一条回复里独占一行输出 ${TERMINAL_TASK_COMPLETE_MARKER}（只输出这个标记，不要加别的内容）。没完成绝不输出此标记。`;

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
export function parseTurnEventLines(chunk: string): Array<{ kind: string; marker?: boolean; summary?: string }> {
  const events: Array<{ kind: string; marker?: boolean; summary?: string }> = [];
  for (const line of chunk.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { kind?: unknown; marker?: unknown; summary?: unknown };
      if (typeof parsed.kind === 'string') {
        events.push({
          kind: parsed.kind,
          marker: typeof parsed.marker === 'boolean' ? parsed.marker : undefined,
          summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        });
      }
    } catch { /* torn line — wait for the next change event */ }
  }
  return events;
}

// ── Session ──────────────────────────────────────────────────────────────────

const READY_FALLBACK_MS = 5_000;
const READY_AFTER_FIRST_OUTPUT_MS = 1_600;
const SUBMIT_DELAY_MS = 150;

interface TerminalSessionDeps {
  host: PtyHost;
  resolveBinary: () => string | null;
  /** Test seam: skip the ready delays. */
  timersEnabled?: boolean;
}

class ClaudeTerminalSession implements BackendSession {
  private readonly config: BackendSessionConfig;
  private readonly emit: (e: BackendSessionEvent) => void;
  private readonly deps: TerminalSessionDeps;
  readonly workerId: string;
  private readonly ahaDir: string;
  private readonly settingsPath: string;
  private readonly hookScriptPath: string;
  private readonly eventsPath: string;
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
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
    deps: TerminalSessionDeps,
  ) {
    this.config = config;
    this.emit = emit;
    this.deps = deps;
    const extraWorkerId = config.extra?.workerId;
    this.workerId = typeof extraWorkerId === 'string' && extraWorkerId.trim()
      ? extraWorkerId.trim()
      : `terminal-${randomUUID()}`;
    this.ahaDir = join(config.cwd, '.aha');
    const suffix = this.workerId.replace(/[^a-zA-Z0-9._-]/g, '_');
    this.settingsPath = join(this.ahaDir, `terminal-claude-settings-${suffix}.json`);
    this.hookScriptPath = join(this.ahaDir, `terminal-stop-hook-${suffix}.cjs`);
    this.eventsPath = join(this.ahaDir, `terminal-turn-events-${suffix}.jsonl`);
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
          message: '未找到 claude CLI，可执行文件不在 PATH 上，也没有可用的内置回退。',
          retryable: false,
        },
      });
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } });
      return;
    }

    // Stop hook plumbing: settings → hook command → append-only events file.
    mkdirSync(this.ahaDir, { recursive: true });
    writeFileSync(this.eventsPath, '');
    this.eventsOffset = 0;
    writeFileSync(this.hookScriptPath, [
      '// AhaStation terminal-worker Stop hook (auto-generated, safe to delete)',
      '// Reads stdin (Claude Code Stop hook payload), checks last_assistant_message',
      '// for the completion marker, and records marker+summary so the adapter can',
      '// auto-complete the task without a human confirm-bar click.',
      "const fs = require('fs');",
      `const MARKER = ${JSON.stringify(TERMINAL_TASK_COMPLETE_MARKER)};`,
      "let last = '';",
      'try {',
      '  const obj = JSON.parse(fs.readFileSync(0, "utf8") || "{}");',
      '  const m = obj.last_assistant_message;',
      '  last = typeof m === "string" ? m : (m ? JSON.stringify(m) : "");',
      '} catch (e) { /* malformed stdin - treat as no marker */ }',
      'const hit = last.includes(MARKER);',
      `fs.appendFileSync(${JSON.stringify(this.eventsPath)}, JSON.stringify({ kind: 'stop', at: Date.now(), marker: hit, summary: hit ? last.slice(0, 20000) : '' }) + '\\n');`,
      '',
    ].join('\n'));
    // process.execPath is Electron in the packaged app; ELECTRON_RUN_AS_NODE
    // (set on the pty env below) makes it act as plain node for the hook.
    const hookCommand = `"${process.execPath}" "${this.hookScriptPath}"`;
    writeFileSync(this.settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 30 }] }],
      },
    }, null, 2));

    const env: NodeJS.ProcessEnv = {
      ...this.config.env,
      ELECTRON_RUN_AS_NODE: '1',
    };
    const cliArgs = ['--settings', this.settingsPath];
    if (this.config.model) cliArgs.push('--model', this.config.model);
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
      signal: { kind: 'progress', message: '终端 Claude 已启动，任务提示词将自动注入 TUI。' },
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
        // Auto-completion: the worker printed the completion marker on its
        // final reply. Emit a delivery signal with a synthesized WorkReport;
        // this converges with the confirm-bar path (submitWorkerReport) in the
        // scheduler's handleWorkerSignal delivery branch. The TUI is then torn
        // down by releaseWorkerSession as part of the normal delivery flow.
        this.emit({
          kind: 'worker-signal',
          signal: {
            kind: 'delivery',
            report: {
              status: 'completed',
              summary: event.summary || '[terminal-worker] 自动完成（marker 检测）',
              files: [],
              tests: [],
              unresolved: [],
            },
          },
        });
      } else {
        // No marker: keep the human-in-the-loop fallback (confirm bar).
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
    // Esc is Claude Code's native "stop this turn" key.
    this.deps.host.write(this.workerId, '\x1b');
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
    for (const path of [this.settingsPath, this.hookScriptPath, this.eventsPath]) {
      try { rmSync(path, { force: true }); } catch { /* best effort */ }
    }
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    return null;
  }
}

// ── Backend ──────────────────────────────────────────────────────────────────

const CLAUDE_TERMINAL_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  executeTasks: true,
  displayName: 'Claude Code (终端)',
  iconId: 'claude',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  defaultModel: 'claude-sonnet-4-20250514',
  models: [
    'claude-sonnet-4-20250514',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-20250514',
  ],
  installHint: '使用本机已安装的 claude CLI（PATH 上的 claude 命令）',
};

export class ClaudeTerminalBackend implements CliBackend {
  readonly id = 'claude-code-terminal';
  readonly capabilities = CLAUDE_TERMINAL_CAPABILITIES;
  private readonly deps: {
    resolveBinary?: () => string | null;
    host?: PtyHost;
    timersEnabled?: boolean;
  };

  constructor(opts: {
    resolveBinary?: () => string | null;
    host?: PtyHost;
    timersEnabled?: boolean;
  } = {}) {
    this.deps = opts;
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
    return new ClaudeTerminalSession(config, emit, {
      host: this.deps.host ?? getPtyHost(),
      resolveBinary: () => this.resolveBinary(),
      timersEnabled: this.deps.timersEnabled,
    });
  }

  resolveBinary(): string | null {
    // An injected resolver (tests) is authoritative — even its null.
    if (this.deps.resolveBinary) return this.deps.resolveBinary();
    return resolveClaudeBinaryForSource();
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // The interactive TUI must see the user's real environment (HOME with
    // ~/.claude OAuth credentials) — no shadow-home isolation here. The
    // orchestrator already restores the real HOME for non-claude-code ids.
    const env: NodeJS.ProcessEnv = { ...mergedSubprocessEnv() };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (typeof value === 'string') env[key] = value;
    }
    if (auth.apiKey) env.ANTHROPIC_API_KEY = auth.apiKey;
    if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl;
    if (auth.model) env.ANTHROPIC_MODEL = auth.model;
    return env;
  }

  async validateAuth(): Promise<{ ok: boolean; error?: string }> {
    // Login state lives in the user's own CLI; the TUI prompts for auth
    // itself when needed, with the user right there to answer.
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    // The interactive TUI owns authentication: when not logged in, claude
    // prompts /login itself while the user watches the terminal. Reporting
    // logged-in here keeps the backend selectable in the planner (the
    // backend-auth list otherwise gates it behind 'needs-login').
    return { loggedIn: true };
  }
}
