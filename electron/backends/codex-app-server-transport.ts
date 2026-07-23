import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerReady {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
  account: Record<string, unknown>;
}

export const SUPPORTED_CODEX_APP_SERVER_VERSION = '0.144.1';

interface AppServerProcess {
  stdin: { write(data: string): unknown; end?(): unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface CodexAppServerTransportOptions {
  binaryPath: string;
  env: NodeJS.ProcessEnv;
  onNotification?: (notification: CodexAppServerNotification) => void;
  onStderr?: (line: string) => void;
  onExit?: (error: Error) => void;
  spawnProcess?: () => AppServerProcess;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Stable stdio JSON-RPC core for the locked Codex app-server runtime. */
export class CodexAppServerTransport {
  private process: AppServerProcess | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private closing = false;

  constructor(private readonly options: CodexAppServerTransportOptions) {}

  async start(): Promise<CodexAppServerReady> {
    if (this.process) throw new Error('Codex app-server already started');
    this.closing = false;
    this.process = this.options.spawnProcess?.() ?? spawn(
      this.options.binaryPath,
      ['app-server', '--stdio'],
      { env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.process.stderr.on('data', (chunk: unknown) => this.options.onStderr?.(String(chunk)));
    this.process.on('error', (error: unknown) => this.handleExit(toError(error)));
    this.process.on('exit', (code: unknown, signal: unknown) => {
      if (this.closing) return;
      this.handleExit(new Error(`Codex app-server exited (${String(code ?? signal ?? 'unknown')})`));
    });

    const initialized = await this.request<Record<string, unknown>>('initialize', {
      clientInfo: { name: 'ahastation', title: 'AhaStation', version: '0.17.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    const userAgent = String(initialized.userAgent ?? '');
    const runtimeVersion = extractCodexRuntimeVersion(userAgent);
    if (runtimeVersion !== SUPPORTED_CODEX_APP_SERVER_VERSION) {
      throw new Error(
        `Unsupported Codex app-server runtime ${runtimeVersion ?? 'unknown'}; `
        + `AhaStation requires ${SUPPORTED_CODEX_APP_SERVER_VERSION}`,
      );
    }
    this.notify('initialized');
    const accountResult = await this.request<{ account: Record<string, unknown> | null; requiresOpenaiAuth: boolean }>(
      'account/read',
      { refreshToken: false },
    );
    if (accountResult.requiresOpenaiAuth && !accountResult.account) {
      throw new Error('Codex authentication required');
    }
    if (!accountResult.account) throw new Error('Codex account is unavailable');
    return {
      userAgent,
      codexHome: String(initialized.codexHome ?? ''),
      platformFamily: String(initialized.platformFamily ?? ''),
      platformOs: String(initialized.platformOs ?? ''),
      account: accountResult.account,
    };
  }

  async openThread(options: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ thread: { id: string } }>('thread/start', options);
    if (!result.thread?.id) throw new Error('Codex app-server returned no thread id');
    return result.thread.id;
  }

  async resumeThread(threadId: string, options: Record<string, unknown>): Promise<string> {
    const result = await this.request<{ thread: { id: string } }>('thread/resume', { threadId, ...options });
    if (!result.thread?.id) throw new Error('Codex app-server returned no resumed thread id');
    return result.thread.id;
  }

  async startTurn(threadId: string, input: unknown[]): Promise<string> {
    const result = await this.request<{ turn: { id: string } }>('turn/start', { threadId, input });
    if (!result.turn?.id) throw new Error('Codex app-server returned no turn id');
    return result.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Codex app-server closed'));
    }
    this.pending.clear();
    this.process?.stdin.end?.();
    this.process?.kill('SIGTERM');
    this.process = null;
  }

  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.process) return Promise.reject(new Error('Codex app-server is not running'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.process?.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.options.onStderr?.(`Invalid app-server JSON: ${line}`);
      return;
    }
    if (typeof message.id === 'number') {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(appServerErrorMessage(message.error)));
      else request.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      this.options.onNotification?.({ method: message.method, params: message.params });
    }
  }

  private handleExit(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.options.onExit?.(error);
  }
}

export function extractCodexRuntimeVersion(userAgent: string): string | null {
  return userAgent.match(/\/(\d+\.\d+\.\d+)(?:\s|\(|$)/)?.[1] ?? null;
}

function appServerErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
