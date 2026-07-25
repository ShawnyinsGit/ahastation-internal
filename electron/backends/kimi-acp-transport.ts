import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface KimiAcpNotification { method: string; params?: unknown }
export interface KimiAcpRequest { id: number | string; method: string; params?: unknown }

interface AcpProcess {
  stdin: { write(data: string): unknown; end?(): unknown };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface KimiAcpTransportOptions {
  binaryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification?: (notification: KimiAcpNotification) => void;
  onRequest?: (request: KimiAcpRequest) => Promise<unknown> | unknown;
  onExit?: (error: Error) => void;
  spawnProcess?: () => AcpProcess;
  allowWriteTextFile?: boolean;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class KimiAcpTransport {
  private process: AcpProcess | null = null;
  private nextId = 0;
  private pending = new Map<number | string, Pending>();
  private closing = false;

  constructor(private readonly options: KimiAcpTransportOptions) {}

  async start(): Promise<Record<string, unknown>> {
    this.process = this.options.spawnProcess?.() ?? spawn(
      this.options.binaryPath,
      ['acp'],
      { cwd: this.options.cwd, env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => this.handleLine(line));
    this.process.on('error', (error: unknown) => this.handleExit(toError(error)));
    this.process.on('exit', (code: unknown, signal: unknown) => {
      if (!this.closing) this.handleExit(new Error(`Kimi ACP exited (${String(code ?? signal ?? 'unknown')})`));
    });
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: this.options.allowWriteTextFile === true,
        },
      },
      clientInfo: { name: 'ahastation', version: '0.16.3' },
    });
  }

  async authenticate(): Promise<void> {
    await this.request('authenticate', { methodId: 'login' });
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = await this.request<{ sessionId: string }>('session/new', { cwd, mcpServers });
    if (!result.sessionId) throw new Error('Kimi ACP returned no session id');
    return result.sessionId;
  }

  async resumeSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = await this.request<{ sessionId?: string }>('session/resume', { sessionId, cwd, mcpServers });
    return result.sessionId ?? sessionId;
  }

  async setMode(sessionId: string, mode: 'plan' | 'default' | 'auto' | 'yolo'): Promise<void> {
    await this.request('session/set_config_option', { sessionId, configId: 'mode', value: mode });
  }

  prompt(sessionId: string, prompt: unknown[]): Promise<{ stopReason?: string }> {
    return this.request('session/prompt', { sessionId, prompt });
  }

  cancel(sessionId: string): void {
    this.notify('session/cancel', { sessionId });
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Kimi ACP closed'));
    }
    this.pending.clear();
    this.process?.stdin.end?.();
    this.process?.kill('SIGTERM');
    this.process = null;
  }

  private request<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    if (!this.process) return Promise.reject(new Error('Kimi ACP is not running'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Kimi ACP request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: Record<string, unknown>): void {
    this.process?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if ((typeof message.id === 'number' || typeof message.id === 'string') && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(errorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.id !== undefined && (typeof message.id === 'number' || typeof message.id === 'string')) {
      void Promise.resolve(this.options.onRequest?.({ id: message.id, method: message.method, params: message.params }))
        .then((result) => this.write({ jsonrpc: '2.0', id: message.id!, result: result ?? {} }))
        .catch((error) => this.write({
          jsonrpc: '2.0', id: message.id!,
          error: { code: -32001, message: errorMessage(error) },
        }));
      return;
    }
    this.options.onNotification?.({ method: message.method, params: message.params });
  }

  private handleExit(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.options.onExit?.(error);
  }
}

function errorMessage(value: unknown): string {
  return typeof value === 'object' && value !== null && 'message' in value
    ? String((value as { message: unknown }).message)
    : String(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
