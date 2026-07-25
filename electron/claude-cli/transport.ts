// transport.ts — child-process plumbing for the claude CLI stream-json mode.
//
// Frames are newline-delimited JSON in both directions: outbound frames
// (user messages, control requests, control responses) are written to stdin,
// inbound frames (stream messages, control requests/responses) are parsed
// from stdout. The line parser is torn-read tolerant — a partial trailing
// line stays buffered until the rest arrives.

import { spawn } from 'node:child_process';

export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Minimal child-process surface the transport relies on. Tests inject fakes
 *  through the `spawnProcess` seam; production uses node:child_process. */
export interface ChildProcessLike {
  stdin: { write(data: string): unknown; end(): void; readonly writableEnded?: boolean } | null;
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: string): unknown;
  readonly killed?: boolean;
  readonly exitCode?: number | null;
}

export type SpawnFn = (spec: SpawnSpec) => ChildProcessLike;

export interface CliTransportDeps {
  spawnFn?: SpawnFn;
  stderr?: (data: string) => void;
  onMessage: (msg: Record<string, unknown>) => void;
  /** Exactly-once terminal callback. `err` is null for a clean exit (code 0)
   *  or an intentional close(); otherwise carries the failure. */
  onExit: (err: Error | null) => void;
  log?: (line: string) => void;
}

export interface CliTransport {
  write(frame: unknown): void;
  endInput(): void;
  /** Kill the process and settle the terminal callback immediately — the
   *  driver's close path must not hang on a process that refuses to die. */
  close(): void;
}

const defaultSpawn: SpawnFn = (spec) => spawn(spec.file, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
}) as unknown as ChildProcessLike;

export function createCliTransport(spec: SpawnSpec, deps: CliTransportDeps): CliTransport {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  const proc = spawnFn(spec);
  let buffer = '';
  let settled = false;
  let intentionalClose = false;

  const settle = (err: Error | null) => {
    if (settled) return;
    settled = true;
    deps.onExit(err);
  };

  proc.stdout?.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        deps.onMessage(JSON.parse(line) as Record<string, unknown>);
      } catch {
        deps.log?.(`[claude-cli] non-JSON stdout line dropped: ${line.slice(0, 200)}`);
      }
    }
  });
  proc.stderr?.on('data', (chunk) => deps.stderr?.(chunk.toString()));
  proc.on('error', (err) => settle(new Error(`Failed to spawn Claude Code process: ${err.message}`)));
  proc.on('exit', (code, signal) => {
    if (intentionalClose || code === 0) {
      settle(null);
      return;
    }
    settle(new Error(
      code !== null
        ? `Claude Code process exited with code ${code}`
        : `Claude Code process terminated by signal ${signal ?? 'unknown'}`,
    ));
  });

  return {
    write(frame) {
      if (settled) return;
      const stdin = proc.stdin;
      if (!stdin || stdin.writableEnded || proc.killed || proc.exitCode != null) return;
      stdin.write(`${JSON.stringify(frame)}\n`);
    },
    endInput() {
      try { proc.stdin?.end(); } catch { /* already closed */ }
    },
    close() {
      intentionalClose = true;
      try { proc.stdin?.end(); } catch { /* ignore */ }
      try { proc.kill(); } catch { /* ignore */ }
      settle(null);
    },
  };
}
