// kimi-adapter.ts — Kimi Code CLI adapter.
// Kimi 0.24+ is a one-shot CLI. Multi-turn conversations resume by passing
// the session id emitted in the stream's `session.resume_hint` meta event.

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { SubprocessBackend } from './subprocess-backend.js';
import { runTerminalLogin } from './terminal-login.js';
import { isolatedSubprocessEnv } from './backend-environment.js';
import type {
  BackendSession, BackendSessionConfig, BackendSessionEvent, BackendAuthConfig,
  BackendCapabilities, NormalizedMessage, UserContentBlock, InputPriority,
} from './cli-backend.js';
import { KimiAcpTransport, type KimiAcpNotification, type KimiAcpRequest } from './kimi-acp-transport.js';

const KIMI_CAPABILITIES: BackendCapabilities = {
  coordinate: false, executeTasks: false,
  displayName: 'Kimi', iconId: 'kimi', mcp: false, permissions: false,
  systemPrompt: true, skills: false, interrupt: true,
  defaultModel: 'kimi-latest',
  installHint: process.platform === 'win32'
    ? 'Kimi CLI is not yet available for Windows. Visit https://code.kimi.com for updates.'
    : 'curl -LsSf https://code.kimi.com/install.sh | bash',
};
const SUPPORTED_KIMI_ACP_VERSION = '0.24.1';

interface KimiStreamEvent {
  role?: string;
  type?: string;
  session_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ type: string; id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  error?: { message: string; code?: string };
}

export function buildKimiCommandArgs(input: {
  prompt: string; model?: string; sessionId?: string;
}): string[] {
  const args: string[] = [];
  if (input.sessionId) args.push('--session', input.sessionId);
  args.push('--prompt', input.prompt, '--output-format', 'stream-json');
  if (input.model && input.model !== 'kimi-latest') args.push('--model', input.model);
  return args;
}

export function parseKimiStreamEvent(line: string): {
  message?: NormalizedMessage; sessionId?: string;
} | null {
  let event: KimiStreamEvent;
  try { event = JSON.parse(line) as KimiStreamEvent; } catch { return null; }
  if (event.role === 'meta' && event.type === 'session.resume_hint' && event.session_id) {
    return { sessionId: event.session_id };
  }
  if (event.error) {
    return { message: {
      type: 'assistant', errorCode: event.error.code ?? 'kimi_error',
      errorDetail: event.error.message,
      message: { role: 'assistant', content: [{ type: 'text', text: `Error: ${event.error.message}` }] },
      raw: event,
    } };
  }
  if (event.role === 'tool') {
    return { message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{
        type: 'tool_result', tool_use_id: event.tool_call_id ?? `tool-${Date.now()}`,
        content: typeof event.content === 'string' ? event.content : JSON.stringify(event.content ?? ''),
      }] }, raw: event,
    } };
  }
  if (event.role !== 'assistant') return null;
  const text = typeof event.content === 'string'
    ? event.content
    : Array.isArray(event.content)
      ? event.content.filter((b) => b.type === 'text' && b.text).map((b) => b.text!).join('')
      : '';
  const tools = (event.tool_calls ?? []).map((tc) => ({
    type: 'tool_use' as const, id: tc.id, name: tc.function.name,
    input: safeJsonParse(tc.function.arguments),
  }));
  if (!text && tools.length === 0) return null;
  return { message: {
    type: 'assistant',
    message: { role: 'assistant', content: [
      ...(text ? [{ type: 'text' as const, text }] : []), ...tools,
    ] }, raw: event,
  } };
}

class KimiAcpSession implements BackendSession {
  private transport: KimiAcpTransport | null = null;
  private sessionId: string | null = null;
  private queue = Promise.resolve();
  private closed = false;
  private firstTurn = true;
  private currentText = '';
  private authRequiredEmitted = false;
  private backendVersion: string | undefined;
  private permissionResolvers = new Map<string, {
    options: Array<Record<string, unknown>>;
    resolve: (result: unknown) => void;
  }>();

  constructor(
    private readonly binary: string,
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    this.transport = new KimiAcpTransport({
      binaryPath: this.binary,
      cwd: this.config.cwd,
      env: this.config.env ?? isolatedSubprocessEnv(),
      onNotification: (notification) => this.onNotification(notification),
      onRequest: (request) => this.onRequest(request),
      onExit: (error) => {
        if (!this.closed) this.emit({ kind: 'error', error: `Kimi ACP error: ${error.message}` });
      },
    });
    try {
      const initialized = await this.transport.start();
      const protocolVersion = initialized.protocolVersion;
      if (protocolVersion !== 1) throw new Error(`Unsupported Kimi ACP protocol: ${String(protocolVersion)}`);
      const agentInfo = isRecord(initialized.agentInfo) ? initialized.agentInfo : {};
      this.backendVersion = typeof agentInfo.version === 'string' ? agentInfo.version : undefined;
      if (this.backendVersion !== SUPPORTED_KIMI_ACP_VERSION) {
        throw new Error(
          `Unsupported Kimi Code runtime ${this.backendVersion ?? 'unknown'}; `
          + `AhaStation requires ${SUPPORTED_KIMI_ACP_VERSION}`,
        );
      }
      await this.transport.authenticate();
      this.sessionId = this.config.resumeSessionId
        ? await this.transport.resumeSession(this.config.resumeSessionId, this.config.cwd)
        : await this.transport.newSession(this.config.cwd);
      // Kimi remains Expert-only in phase one. Enforce its native read-only
      // plan mode in addition to the scheduler capability gate.
      await this.transport.setMode(this.sessionId, 'plan');
    } catch (error) {
      if (isKimiAuthError(String(error))) this.emitAuthRequired();
      this.transport.close();
      this.transport = null;
      throw error;
    }
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    const prompt = withKimiSystemPrompt(
      [{ type: 'text', text }],
      this.config.systemPrompt,
      this.firstTurn,
    );
    this.firstTurn = false;
    this.enqueuePrompt(prompt);
  }

  sendUserContent(content: string | UserContentBlock[], _priority?: InputPriority): void {
    if (typeof content === 'string') return this.sendUserText(content);
    const prompt = withKimiSystemPrompt(content.map((block) => block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', data: block.source.data, mimeType: block.source.media_type }),
    this.config.systemPrompt, this.firstTurn);
    this.firstTurn = false;
    this.enqueuePrompt(prompt);
  }

  private enqueuePrompt(prompt: unknown[]): void {
    if (this.closed || this.authRequiredEmitted || !this.transport || !this.sessionId) return;
    this.queue = this.queue.then(async () => {
      if (this.closed || !this.transport || !this.sessionId) return;
      this.currentText = '';
      try {
        await this.transport.prompt(this.sessionId, prompt);
        const text = this.currentText.trim();
        if (text && !this.closed) {
          this.emit({ kind: 'message', message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text }] },
          } });
        }
      } catch (error) {
        if (isKimiAuthError(String(error))) this.emitAuthRequired();
        else if (!this.closed) this.emit({ kind: 'error', error: `Kimi ACP prompt failed: ${String(error)}` });
      }
    });
  }

  private onNotification(notification: KimiAcpNotification): void {
    if (notification.method !== 'session/update' || !isRecord(notification.params)) return;
    const update = notification.params.update;
    if (!isRecord(update)) return;
    if (update.sessionUpdate === 'agent_message_chunk' && isRecord(update.content)) {
      if (update.content.type === 'text' && typeof update.content.text === 'string') {
        this.currentText += update.content.text;
      }
    }
  }

  private async onRequest(request: KimiAcpRequest): Promise<unknown> {
    if (request.method === 'fs/read_text_file' && isRecord(request.params)) {
      const requestedPath = String(request.params.path ?? '');
      const path = await resolveKimiReadPath(this.config.cwd, requestedPath);
      const content = await readFile(path, 'utf8');
      if (content.length > 2_000_000) throw new Error('File exceeds the 2 MB ACP read limit');
      return { content };
    }
    if (request.method === 'fs/write_text_file') throw new Error('Kimi Expert sessions are read-only');
    if (request.method === 'session/request_permission' && isRecord(request.params)) {
      const params = request.params;
      const id = String(request.id);
      const options = Array.isArray(params.options)
        ? params.options.filter(isRecord)
        : [];
      return new Promise((resolvePermission) => {
        this.permissionResolvers.set(id, { options, resolve: resolvePermission });
        const toolCall = isRecord(params.toolCall) ? params.toolCall : {};
        this.emit({
          kind: 'permission-request', id,
          toolName: String(toolCall.title ?? toolCall.kind ?? 'Kimi tool'),
          input: isRecord(toolCall.rawInput) ? toolCall.rawInput : {},
          toolUseID: String(toolCall.toolCallId ?? id),
        });
      });
    }
    throw new Error(`Unsupported Kimi ACP client request: ${request.method}`);
  }

  resolvePermission(id: string, decision: 'allow' | 'deny'): void {
    const pending = this.permissionResolvers.get(id);
    if (!pending) return;
    this.permissionResolvers.delete(id);
    const desired = decision === 'allow' ? /^allow/ : /^(reject|deny)/;
    const option = pending.options.find((item) => desired.test(String(item.kind ?? '')))
      ?? pending.options[0];
    pending.resolve(option
      ? { outcome: { outcome: 'selected', optionId: option.optionId } }
      : { outcome: { outcome: 'cancelled' } });
  }

  async interrupt(): Promise<void> {
    if (this.transport && this.sessionId) this.transport.cancel(this.sessionId);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.permissionResolvers.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.permissionResolvers.clear();
    this.transport?.close();
    this.transport = null;
    this.emit({ kind: 'ended' });
    this.emit = () => undefined;
  }

  snapshot(): { protocol: string; sessionId: string; protocolVersion: string; backendVersion?: string } | null {
    return this.sessionId ? {
      protocol: 'kimi-acp', protocolVersion: '1',
      sessionId: this.sessionId, backendVersion: this.backendVersion,
    } : null;
  }

  private emitAuthRequired(): void {
    if (this.authRequiredEmitted) return;
    this.authRequiredEmitted = true;
    this.emit({ kind: 'auth-required', error: 'Kimi 登录已失效，请完成重新认证后重连。' });
  }
}

class KimiSession implements BackendSession {
  private process: ChildProcess | null = null;
  private closed = false;
  private sessionId?: string;
  private queue = Promise.resolve();
  private firstTurn = true;
  private authRequiredEmitted = false;

  constructor(
    private readonly binary: string,
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
  ) {}

  async start(): Promise<void> {
    // One-shot prompt mode has no transport handshake. Treat construction as
    // locally ready and defer the first paid model turn until real user input.
    // Kimi ACP will replace this compatibility path with a protocol initialize.
  }

  private runTurn(prompt: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const env = { ...(this.config.env ?? isolatedSubprocessEnv()) };
      env.PATH = [dirname(this.binary), env.PATH].filter(Boolean).join(delimiter);
      const proc = spawn(this.binary, buildKimiCommandArgs({
        prompt, model: this.config.model, sessionId: this.sessionId,
      }), { cwd: this.config.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.process = proc;
      let stdout = '';
      let stderr = '';
      const consume = (line: string) => {
        const parsed = parseKimiStreamEvent(line.trim());
        if (parsed?.sessionId) this.sessionId = parsed.sessionId;
        if (parsed?.message && !this.closed) {
          if (isKimiAuthError(`${parsed.message.errorCode ?? ''} ${parsed.message.errorDetail ?? ''}`)) {
            this.emitAuthRequired();
          } else {
            this.emit({ kind: 'message', message: parsed.message });
          }
        }
      };
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) consume(line);
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-1000); });
      proc.once('error', (error) => {
        if (this.process === proc) this.process = null;
        if (!this.closed) this.emit({ kind: 'error', error: `Kimi 启动失败：${error.message}` });
        reject(error);
      });
      proc.once('close', (code, signal) => {
        if (stdout.trim()) consume(stdout);
        if (this.process === proc) this.process = null;
        if (this.authRequiredEmitted) {
          resolve();
        } else if (!this.closed && code !== 0 && signal !== 'SIGINT' && signal !== 'SIGTERM') {
          const detail = stderr.trim() || `exit ${code}`;
          if (isKimiAuthError(detail)) {
            this.emitAuthRequired();
            resolve();
          } else {
            this.emit({ kind: 'error', error: `Kimi 执行失败：${detail}` });
            reject(new Error(detail));
          }
        } else resolve();
      });
    });
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    if (this.closed || this.authRequiredEmitted) return;
    const prefix = this.firstTurn && this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n---\n\n`
      : '';
    this.firstTurn = false;
    this.queue = this.queue.then(() => this.runTurn(prefix + text)).catch(() => undefined);
  }

  sendUserContent(content: string | UserContentBlock[], priority?: InputPriority): void {
    if (typeof content === 'string') return this.sendUserText(content, priority);
    const text = content.filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text).join('\n');
    if (text) this.sendUserText(text, priority);
  }

  resolvePermission(): void {}
  async interrupt(): Promise<void> { this.process?.kill('SIGINT'); }
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.process?.kill('SIGTERM');
    this.emit({ kind: 'ended' });
    this.emit = () => undefined;
  }

  private emitAuthRequired(): void {
    if (this.authRequiredEmitted) return;
    this.authRequiredEmitted = true;
    this.emit({ kind: 'auth-required', error: 'Kimi 登录已失效，请完成重新认证后重连。' });
    this.process?.kill('SIGTERM');
  }
}

function isKimiAuthError(message: string): boolean {
  return /\b401\b|unauthorized|authentication[_\s-]?(?:failed|required)|token (?:expired|revoked)/i.test(message);
}

export function hasUsableKimiCredentials(path: string, nowSeconds = Date.now() / 1000): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      access_token?: unknown; refresh_token?: unknown; expires_at?: unknown;
    };
    if (typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0) return true;
    return typeof parsed.access_token === 'string'
      && parsed.access_token.length > 0
      && typeof parsed.expires_at === 'number'
      && parsed.expires_at > nowSeconds + 60;
  } catch {
    return false;
  }
}

function safeJsonParse(value: string): Record<string, unknown> {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return { raw: value }; }
}

export class KimiBackend extends SubprocessBackend {
  readonly id = 'kimi';
  readonly capabilities = KIMI_CAPABILITIES;
  readonly binaryName = 'kimi';

  resolveBinary(): string | null {
    const canonical = join(homedir(), '.kimi-code', 'bin', 'kimi');
    try {
      accessSync(canonical, fsConstants.X_OK);
      return realpathSync(canonical);
    } catch {
      return super.resolveBinary();
    }
  }

  createSession(config: BackendSessionConfig, emit: (e: BackendSessionEvent) => void): BackendSession {
    const binary = this.resolveBinary();
    if (!binary) {
      emit({ kind: 'error', error: 'Kimi CLI not found. Install with: curl -LsSf https://code.kimi.com/install.sh | bash' });
      emit({ kind: 'ended' });
      return createNoopSession();
    }
    return config.extra?.kimiTransport === 'acp'
      ? new KimiAcpSession(binary, config, emit)
      : new KimiSession(binary, config, emit);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = super.buildEnv(auth, extra);
    if (auth.apiKey) env.MOONSHOT_API_KEY = auth.apiKey;
    if (auth.baseUrl) env.MOONSHOT_BASE_URL = auth.baseUrl;
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    return config.authMode === 'apikey' && !config.apiKey
      ? { ok: false, error: 'MOONSHOT_API_KEY is required' } : { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    const binary = this.resolveBinary();
    if (!binary) return { loggedIn: false };
    const transport = new KimiAcpTransport({
      binaryPath: binary,
      cwd: homedir(),
      env: isolatedSubprocessEnv(),
    });
    try {
      const initialized = await transport.start();
      const agentInfo = isRecord(initialized.agentInfo) ? initialized.agentInfo : {};
      if (initialized.protocolVersion !== 1 || agentInfo.version !== SUPPORTED_KIMI_ACP_VERSION) {
        return { loggedIn: false };
      }
      await transport.authenticate();
      await transport.newSession(homedir());
      return { loggedIn: true };
    } catch {
      return { loggedIn: false };
    } finally {
      transport.close();
    }
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) return { ok: false, error: 'Kimi CLI not found. Install it first.' };
    return runTerminalLogin(
      binary, ['login'], () => this.checkAuthStatus(), isolatedSubprocessEnv(),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function withKimiSystemPrompt(
  prompt: Array<Record<string, unknown>>,
  systemPrompt: string | undefined,
  firstTurn: boolean,
): Array<Record<string, unknown>> {
  if (!firstTurn || !systemPrompt) return prompt;
  return [{ type: 'text', text: `${systemPrompt}\n\n---\n\n` }, ...prompt];
}

export async function resolveKimiReadPath(cwd: string, requestedPath: string): Promise<string> {
  const lexicalTarget = resolve(cwd, requestedPath);
  const [realRoot, realTarget] = await Promise.all([realpath(cwd), realpath(lexicalTarget)]);
  const rel = relative(realRoot, realTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Path is outside the Meeting workspace');
  }
  return realTarget;
}


function createNoopSession(): BackendSession {
  return { async start() {}, end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {}, async interrupt() {} };
}
