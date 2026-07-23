// claude-code-adapter.ts — wraps the existing ClaudeSession into the
// CliBackend/BackendSession interface.
//
// This adapter does NOT replace or modify ClaudeSession. It constructs one
// internally and translates SessionEvent → BackendSessionEvent at the
// boundary. Since NormalizedMessage is designed to be SDKMessage-compatible
// (same `message.content` shape), the translation is mostly a pass-through.
//
// The Orchestrator/WorkerScheduler consume BackendSession; this adapter is
// the bridge that lets them use Claude Code without knowing about SDK types.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { ClaudeSession, type SessionEvent, type InputPriority as CSInputPriority } from '../claude-session.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
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
import type { AutoApproveScope } from '../auto-approve-policy.js';
import type { ConfirmDestructive } from '../claude-session.js';
import { runTerminalLogin } from './terminal-login.js';
import { isolatedSubprocessEnv } from './backend-environment.js';

const require_ = createRequire(import.meta.url);

// ── Binary resolution ─────────────────────────────────────────────────────────
// Reuses the same resolution logic as ClaudeSession but exposed as a standalone
// function for the registry's availability check.

function unpackify(p: string): string {
  return p.replace(/[\\/]app\.asar[\\/]/, (_, sep) => `${sep}app.asar.unpacked${sep}`);
}

export function resolveClaudeBinary(): string | undefined {
  const platform = process.platform;
  const arch = process.arch === 'x64' ? `${platform}-x64` : `${platform}-arm64`;
  const subpkg = `@anthropic-ai/claude-agent-sdk-${arch}/claude`;

  try {
    const sdkPkg = require_.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const sdkRequire = createRequire(sdkPkg);
    const p = unpackify(sdkRequire.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  try {
    const p = unpackify(require_.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  const guesses = [
    process.resourcesPath && `${process.resourcesPath}/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/node_modules/${subpkg}`,
    process.resourcesPath && `${process.resourcesPath}/app.asar.unpacked/node_modules/${subpkg}`,
  ].filter((x): x is string => !!x);
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  return undefined;
}

// ── Session adapter ────────────────────────────────────────────────────────────
// Wraps a ClaudeSession instance and exposes the BackendSession interface.

class ClaudeCodeSession implements BackendSession {
  private inner: ClaudeSession;

  constructor(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
    confirmDestructive?: ConfirmDestructive,
    queryFactory?: typeof import('@anthropic-ai/claude-agent-sdk').query,
  ) {
    // Translate BackendSessionConfig → ClaudeSession constructor options.
    // The NormalizedMessage shape is SDKMessage-compatible, so we can pass
    // the session events through with minimal wrapping.
    this.inner = new ClaudeSession({
      emit: (event: SessionEvent) => {
        // SessionEvent.message is already SDKMessage-shaped, which is
        // NormalizedMessage-compatible. Pass through directly.
        emit(event as BackendSessionEvent);
      },
      cwd: config.cwd,
      sessionOptions: buildClaudeSessionOptions(config),
      autoApproveScope: config.autoApproveScope ?? 'off',
      envOverride: config.env,
      confirmDestructive,
      queryFactory,
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  end(): void {
    this.inner.end();
  }

  sendUserText(text: string, priority?: InputPriority): void {
    this.inner.sendUserText(text, (priority ?? 'normal') as CSInputPriority);
  }

  sendUserContent(content: UserContentBlock[], priority?: InputPriority): void {
    // UserContentBlock is compatible with SDKUserMessage content blocks
    // (same { type: 'text', text } and { type: 'image', source } shapes).
    this.inner.sendUserContent(
      content as Parameters<ClaudeSession['sendUserContent']>[0],
      (priority ?? 'normal') as CSInputPriority,
    );
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string): void {
    this.inner.resolvePermission(id, decision, message);
  }

  async interrupt(): Promise<void> {
    await this.inner.interrupt();
  }

  setAutoApproveScope(scope: AutoApproveScope): void {
    this.inner.setAutoApproveScope(scope);
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.inner.setPermissionMode(
      mode as Parameters<ClaudeSession['setPermissionMode']>[0],
    );
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    return this.inner.snapshot();
  }
}

function buildClaudeSessionOptions(config: BackendSessionConfig): Record<string, unknown> {
  const extra = { ...(config.extra ?? {}) };
  delete extra.meetingCommandHandler;
  if (config.systemPrompt !== undefined && extra.systemPrompt === undefined) {
    extra.systemPrompt = config.systemPrompt;
  }
  if (config.model !== undefined) extra.model = config.model;
  if (config.mcpServers !== undefined) extra.mcpServers = config.mcpServers;
  if (config.skills !== undefined) extra.skills = config.skills;
  if (config.resumeSessionId !== undefined) extra.resume = config.resumeSessionId;
  return extra;
}

// ── Backend implementation ─────────────────────────────────────────────────────

const CLAUDE_CODE_CAPABILITIES: BackendCapabilities = {
  coordinate: true,
  executeTasks: true,
  displayName: 'Claude Code',
  iconId: 'claude',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: true,
  interrupt: true,
  defaultModel: 'claude-sonnet-4-20250514',
  models: [
    'claude-sonnet-4-20250514',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-20250514',
  ],
  npmPackage: '@anthropic-ai/claude-agent-sdk',
  installHint: 'Bundled with AhaStation',
};

export class ClaudeCodeBackend implements CliBackend {
  readonly id = 'claude-code';
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;
  private confirmDestructive?: ConfirmDestructive;
  private readonly deps: {
    resolveBinary?: () => string | null;
    execFile?: (binary: string, args: string[], options?: Record<string, unknown>) => string;
    queryFactory?: typeof import('@anthropic-ai/claude-agent-sdk').query;
  };

  constructor(opts: {
    confirmDestructive?: ConfirmDestructive;
    resolveBinary?: () => string | null;
    execFile?: (binary: string, args: string[], options?: Record<string, unknown>) => string;
  } = {}) {
    this.confirmDestructive = opts?.confirmDestructive;
    this.deps = opts;
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    return new ClaudeCodeSession(config, emit, this.confirmDestructive, this.deps.queryFactory);
  }

  resolveBinary(): string | null {
    return this.deps.resolveBinary?.() ?? resolveClaudeBinary() ?? null;
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const base = mergedSubprocessEnv();
    const env: NodeJS.ProcessEnv = { ...base, ...isolatedSubprocessEnv(extra) };
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (
        typeof value === 'string'
        && (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_') || key.startsWith('XDG_'))
      ) env[key] = value;
    }

    if (auth.apiKey) {
      env.ANTHROPIC_API_KEY = auth.apiKey;
    }
    if (auth.baseUrl) {
      env.ANTHROPIC_BASE_URL = auth.baseUrl;
    }
    if (auth.model) {
      env.ANTHROPIC_MODEL = auth.model;
    }

    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey) {
      return { ok: false, error: 'API key is required for apikey auth mode' };
    }
    return { ok: true };
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) return { ok: false, error: 'Claude CLI runtime is unavailable.' };
    return runTerminalLogin(
      binary, ['auth', 'login'], () => this.checkAuthStatus(), isolatedSubprocessEnv(),
    );
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    const binary = this.resolveBinary();
    if (!binary) return { loggedIn: false };
    try {
      const run = this.deps.execFile ?? ((file: string, args: string[]) =>
        execFileSync(file, args, {
          env: mergedSubprocessEnv(), encoding: 'utf8', timeout: 10_000,
        }));
      const output = run(binary, ['auth', 'status', '--json'], {
        encoding: 'utf8', timeout: 10_000,
      });
      const parsed = JSON.parse(output.trim()) as { loggedIn?: unknown };
      return { loggedIn: parsed.loggedIn === true };
    } catch {
      return { loggedIn: false };
    }
  }
}
