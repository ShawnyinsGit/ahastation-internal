// qoder-adapter.ts — Qoder Agent SDK backend adapter.
//
// Qoder's supported host integration is @qoder-ai/qoder-agent-sdk `query()`.
// Do not silently fall back to guessed CLI flags: runtime protocol drift must
// fail during the readiness handshake instead of corrupting a live meeting.

import type { BackendSession, BackendSessionConfig, BackendSessionEvent,
  BackendAuthConfig, BackendCapabilities, InputPriority, NormalizedMessage,
  UserContentBlock } from './cli-backend.js';
import type { AutoApproveScope } from '../auto-approve-policy.js';
import { accessSync, constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import { runTerminalLogin } from './terminal-login.js';
import { isolatedSubprocessEnv } from './backend-environment.js';

const QODER_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  // WorkReport/meeting-worker completion is not bridged through this SDK path yet.
  executeTasks: false,
  displayName: 'Qoder',
  iconId: 'qoder',
  mcp: true,
  permissions: true,
  systemPrompt: true,
  skills: true,
  interrupt: true,
  defaultModel: 'auto',
  npmPackage: undefined,
  installHint: 'Bundled with AhaStation',
};

interface QoderQuery extends AsyncIterable<unknown> {
  initializationResult(): Promise<Record<string, unknown>>;
  accountInfo?(): Promise<Record<string, unknown>>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
}

interface QoderSdkModule {
  query(input: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): QoderQuery;
  qodercliAuth(): unknown;
  accessToken(token: string): unknown;
}

type QoderBackendDeps = {
  resolveBinary?: () => string | null;
  loadSdk?: () => Promise<QoderSdkModule>;
};

let sdkCache: QoderSdkModule | undefined;
async function loadQoderSdk(): Promise<QoderSdkModule> {
  if (sdkCache) return sdkCache;
  const mod = await import('@qoder-ai/qoder-agent-sdk');
  sdkCache = mod as unknown as QoderSdkModule;
  return sdkCache;
}

class AsyncInputQueue implements AsyncIterable<unknown> {
  private values: unknown[] = [];
  private waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  private closed = false;

  push(value: unknown): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift(), done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type PendingPermission = {
  input: Record<string, unknown>;
  resolve: (result: Record<string, unknown>) => void;
};

class QoderSdkSession implements BackendSession {
  private readonly input = new AsyncInputQueue();
  private readonly permissions = new Map<string, PendingPermission>();
  private query: QoderQuery | null = null;
  private closed = false;
  private ended = false;
  private authRequiredEmitted = false;
  private autoApproveScope: AutoApproveScope;

  constructor(
    private readonly binary: string,
    private readonly config: BackendSessionConfig,
    private readonly sdkLoader: () => Promise<QoderSdkModule>,
    private emit: (event: BackendSessionEvent) => void,
  ) {
    this.autoApproveScope = config.autoApproveScope ?? 'off';
  }

  async start(): Promise<void> {
    if (this.closed || this.query) return;
    const sdk = await this.sdkLoader();
    const env = stringEnv(this.config.env ?? isolatedSubprocessEnv());
    const token = env.QODER_PERSONAL_ACCESS_TOKEN;
    const auth = token ? sdk.accessToken(token) : sdk.qodercliAuth();
    const query = sdk.query({
      prompt: this.input,
      options: {
        auth,
        cwd: this.config.cwd,
        env,
        pathToQoderCLIExecutable: this.binary,
        model: this.config.model && this.config.model !== 'auto' ? this.config.model : undefined,
        systemPrompt: this.config.systemPrompt,
        skills: this.config.skills,
        enableFileCheckpointing: true,
        permissionMode: 'default',
        canUseTool: (toolName: string, input: Record<string, unknown>, options: {
          signal: AbortSignal; toolUseID: string;
        }) => this.requestPermission(toolName, input, options),
        onAuthExpired: () => this.emitAuthRequired(),
      },
    });
    this.query = query;
    void this.consume(query);

    const prefix = this.config.systemPrompt ? '' : 'You are a Qoder agent participating in AhaStation.\n\n';
    this.input.push(userMessage(`${prefix}Ready. Awaiting instructions.`, 'normal'));
    try {
      await withTimeout(query.initializationResult(), 15_000, 'Qoder SDK readiness handshake timed out');
    } catch (error) {
      this.closed = true;
      this.input.close();
      await query.close().catch(() => undefined);
      this.query = null;
      throw error;
    }
  }

  private async consume(query: QoderQuery): Promise<void> {
    try {
      for await (const raw of query) {
        if (this.closed) break;
        const event = raw as Record<string, unknown>;
        if (event.type === 'assistant') {
          const message = normalizeQoderMessage(event);
          if (message) this.emit({ kind: 'message', message });
        } else if (event.type === 'result' && event.subtype !== 'success') {
          const detail = resultError(event);
          if (/auth|unauthorized|\b401\b/i.test(detail)) this.emitAuthRequired();
          else this.emit({ kind: 'error', error: `Qoder execution failed: ${detail}` });
        }
      }
      if (!this.closed) this.emitEnded();
    } catch (error) {
      if (!this.closed) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/auth|unauthorized|\b401\b/i.test(detail)) this.emitAuthRequired();
        else this.emit({ kind: 'error', error: `Qoder SDK error: ${detail}` });
        this.emitEnded();
      }
    }
  }

  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.resolve({
      behavior: 'deny', message: 'Session closed', toolUseID: options.toolUseID,
    });
    // Existing AhaStation auto-approve policy remains separate from orchestration.
    // Only the explicit broad scopes skip the renderer prompt here.
    if (this.autoApproveScope === 'all') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID });
    }
    return new Promise((resolve) => {
      this.permissions.set(options.toolUseID, { input, resolve });
      options.signal.addEventListener('abort', () => {
        if (!this.permissions.delete(options.toolUseID)) return;
        resolve({ behavior: 'deny', message: 'Permission request cancelled', toolUseID: options.toolUseID });
      }, { once: true });
      this.emit({
        kind: 'permission-request',
        id: options.toolUseID,
        toolName,
        input,
        toolUseID: options.toolUseID,
      });
    });
  }

  sendUserText(text: string, priority: InputPriority = 'normal'): void {
    if (!text || this.closed || this.authRequiredEmitted) return;
    this.input.push(userMessage(text, priority));
  }

  sendUserContent(content: string | UserContentBlock[], priority: InputPriority = 'normal'): void {
    if (typeof content === 'string') return this.sendUserText(content, priority);
    if (this.closed || this.authRequiredEmitted || content.length === 0) return;
    this.input.push({
      type: 'user', parent_tool_use_id: null, priority: qoderPriority(priority),
      message: { role: 'user', content },
    });
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string): void {
    const pending = this.permissions.get(id);
    if (!pending) return;
    this.permissions.delete(id);
    pending.resolve(decision === 'allow'
      ? { behavior: 'allow', updatedInput: pending.input, toolUseID: id }
      : { behavior: 'deny', message: message ?? 'Denied by user', toolUseID: id });
  }

  async interrupt(): Promise<void> { await this.query?.interrupt(); }
  setAutoApproveScope(scope: AutoApproveScope): void { this.autoApproveScope = scope; }
  async setPermissionMode(mode: string): Promise<void> { await this.query?.setPermissionMode?.(mode); }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    for (const [id, pending] of this.permissions) {
      pending.resolve({ behavior: 'deny', message: 'Session closed', toolUseID: id });
    }
    this.permissions.clear();
    void this.query?.close().catch(() => undefined);
    this.emitEnded();
  }

  private emitAuthRequired(): void {
    if (this.authRequiredEmitted || this.closed) return;
    this.authRequiredEmitted = true;
    this.emit({ kind: 'auth-required', error: 'Qoder 登录已失效，请重新认证后重连。' });
  }

  private emitEnded(): void {
    if (this.ended) return;
    this.ended = true;
    this.emit({ kind: 'ended' });
  }
}

function userMessage(text: string, priority: InputPriority): Record<string, unknown> {
  return {
    type: 'user', parent_tool_use_id: null, priority: qoderPriority(priority),
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function qoderPriority(priority: InputPriority): 'now' | 'next' | 'later' {
  return priority === 'high' ? 'now' : priority === 'low' ? 'later' : 'next';
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] =>
    typeof entry[1] === 'string'));
}

function normalizeQoderMessage(event: Record<string, unknown>): NormalizedMessage | null {
  const message = event.message;
  if (!message || typeof message !== 'object') return null;
  return { type: 'assistant', message: message as NormalizedMessage['message'], raw: event };
}

function resultError(event: Record<string, unknown>): string {
  if (Array.isArray(event.errors)) return event.errors.map(String).join('; ');
  if (typeof event.result === 'string') return event.result;
  return typeof event.subtype === 'string' ? event.subtype : 'unknown error';
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

export class QoderBackend {
  readonly id = 'qoder';
  readonly capabilities = QODER_CAPABILITIES;
  readonly binaryName = 'qodercli';

  constructor(private readonly deps: QoderBackendDeps = {}) {}

  resolveBinary(): string | null {
    if (this.deps.resolveBinary) return this.deps.resolveBinary();
    return resolveQoderRuntime();
  }

  createSession(config: BackendSessionConfig, emit: (event: BackendSessionEvent) => void): BackendSession {
    const binary = this.resolveBinary();
    if (!binary) {
      emit({ kind: 'error', error: 'Bundled Qoder CLI is unavailable. Reinstall AhaStation or select a compatible system runtime.' });
      emit({ kind: 'ended' });
      return noopSession();
    }
    return new QoderSdkSession(binary, config, this.deps.loadSdk ?? loadQoderSdk, emit);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = isolatedSubprocessEnv(extra);
    if (auth.apiKey) env.QODER_PERSONAL_ACCESS_TOKEN = auth.apiKey;
    if (auth.baseUrl) env.QODER_BASE_URL = auth.baseUrl;
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    return config.authMode === 'apikey' && !config.apiKey
      ? { ok: false, error: 'QODER_PERSONAL_ACCESS_TOKEN is required' }
      : { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    const binary = this.resolveBinary();
    if (!binary) return { loggedIn: false };
    let query: QoderQuery | undefined;
    try {
      const sdk = await (this.deps.loadSdk ?? loadQoderSdk)();
      async function* noInput(): AsyncGenerator<never> { /* initialization only */ }
      query = sdk.query({
        prompt: noInput(),
        options: {
          auth: sdk.qodercliAuth(),
          pathToQoderCLIExecutable: binary,
          env: stringEnv(isolatedSubprocessEnv()),
        },
      });
      await withTimeout(query.initializationResult(), 10_000, 'auth probe timeout');
      const account = await query.accountInfo?.();
      return { loggedIn: Boolean(account && Object.keys(account).length > 0) };
    } catch {
      return { loggedIn: false };
    } finally {
      await query?.close().catch(() => undefined);
    }
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) return { ok: false, error: 'Bundled Qoder CLI is unavailable. Reinstall AhaStation.' };
    return runTerminalLogin(
      binary, ['login'], () => this.checkAuthStatus(), isolatedSubprocessEnv(),
    );
  }
}

/** Resolve an OS-executable path rather than an ASAR virtual path. The Qoder
 * SDK accepts this through pathToQoderCLIExecutable. */
export function resolveQoderRuntime(
  resourcesPath = process.resourcesPath,
  resolveSystem: () => string | null = () => resolveBinaryFromPath('qodercli'),
): string | null {
  const candidates = [
    resourcesPath ? join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js') : '',
    join(process.cwd(), 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js'),
    resolveSystem() ?? '',
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
    } catch { /* continue */ }
  }
  return null;
}

function noopSession(): BackendSession {
  return { async start() {}, end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {} };
}
