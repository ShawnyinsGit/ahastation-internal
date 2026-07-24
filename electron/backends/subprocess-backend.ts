// subprocess-backend.ts — abstract base class for CLI backends that don't
// have a JavaScript SDK. Spawns the CLI binary as a child process,
// communicates via stdin (JSON prompts) and parses stdout (JSONL events).
//
// Concrete adapters (Kimi, future CLIs) extend this class and implement:
//   • buildArgs(config) — CLI arguments for spawning
//   • parseStdoutLine(line) — convert a JSONL line to NormalizedMessage
//   • formatPrompt(config) — format the initial prompt for the CLI
//
// The base class handles:
//   • Process lifecycle (spawn, kill, cleanup)
//   • Stdin/stdout/stderr piping
//   • Exit code handling (0=success, non-zero=error)
//   • stderr ring buffer for error diagnostics

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import {
  type BackendSession,
  type BackendSessionConfig,
  type BackendSessionEvent,
  type BackendAuthConfig,
  type BackendCapabilities,
  type CliBackend,
  type InputPriority,
  type NormalizedMessage,
  type UserContentBlock,
} from './cli-backend.js';
import { isolatedSubprocessEnv } from './backend-environment.js';

// ── Subprocess session ────────────────────────────────────────────────────────
// Controls a spawned CLI process. Sends prompts via stdin, reads JSONL from
// stdout, captures stderr for diagnostics.

/** Strip absolute paths from error messages to avoid leaking filesystem layout. */
function sanitizeError(msg: string): string {
  // Replace common absolute path patterns with a generic placeholder.
  // Unix paths: /Users/foo/..., /home/foo/..., etc.
  // Windows paths: C:\Users\foo\..., D:\Program Files\..., etc.
  return msg
    .replace(/\/(?:Users?|home|opt|usr|var|tmp|private|Applications?)\/[^\s:'"]+/g, '<path>')
    .replace(/[A-Z]:\\[^\s:'"]+/g, '<path>');
}

export abstract class SubprocessSession implements BackendSession {
  protected process: ChildProcess | null = null;
  protected stderrRing: string[] = [];
  protected closed = false;
  protected emit: (e: BackendSessionEvent) => void;
  protected config: BackendSessionConfig;
  protected binaryPath: string;

  constructor(
    binaryPath: string,
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ) {
    this.binaryPath = binaryPath;
    this.config = config;
    this.emit = emit;
  }

  /** Subclasses implement: build CLI arguments for spawning. */
  protected abstract buildArgs(config: BackendSessionConfig): string[];

  /** Subclasses implement: parse one stdout line into a NormalizedMessage. */
  protected abstract parseStdoutLine(line: string): NormalizedMessage | null;

  /** Subclasses implement: format the initial prompt string. */
  protected abstract formatPrompt(config: BackendSessionConfig): string;

  async start(): Promise<void> {
    if (this.process || this.closed) return;

    const args = this.buildArgs(this.config);
    // Use minimal environment if not explicitly provided to avoid leaking
    // Electron internals or other backend API keys.
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const spawnEnv = this.config.env ?? {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: process.env.USERPROFILE,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    };
    try {
      this.process = spawn(this.binaryPath, args, {
        cwd: this.config.cwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      this.emit({ kind: 'error', error: sanitizeError(`Failed to spawn ${this.binaryPath}: ${String(err)}`) });
      this.emit({ kind: 'ended' });
      return;
    }

    // stdout: JSONL line-by-line
    let buffer = '';
    this.process.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = this.parseStdoutLine(trimmed);
          if (msg) {
            this.emit({ kind: 'message', message: msg });
          }
        } catch (err) {
          console.warn('[subprocess-backend] parseStdoutLine failed:', trimmed.slice(0, 200), err);
        }
      }
    });

    // stderr: diagnostic ring buffer
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrRing.push(text);
      if (this.stderrRing.length > 40) this.stderrRing.shift();
      // Only log stderr at debug level; avoid leaking sensitive data to console
    });

    // Exit handling
    this.process.on('close', (code: number | null, signal: string | null) => {
      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          const msg = this.parseStdoutLine(buffer.trim());
          if (msg) this.emit({ kind: 'message', message: msg });
        } catch { /* ignore */ }
      }

      if (!this.closed) {
        if (code !== null && code !== 0) {
          const stderrTail = this.stderrRing.join('').slice(-500).trim();
          this.emit({
            kind: 'error',
            error: sanitizeError(`${this.binaryPath} exited with code ${code}${stderrTail ? `: ${stderrTail}` : ''}`),
          });
        }
        this.emit({ kind: 'ended' });
        this.emit = () => {};
      }
      this.process = null;
    });

    this.process.on('error', (err: Error) => {
      if (!this.closed) {
        this.emit({ kind: 'error', error: sanitizeError(`${this.binaryPath} process error: ${err.message}`) });
        this.emit({ kind: 'ended' });
        this.emit = () => {};
      }
      this.process = null;
    });

    // Send the initial prompt via stdin
    const prompt = this.formatPrompt(this.config);
    this.writeStdin(prompt);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.process) {
      // Close stdin first so the process knows no more input is coming.
      // Some CLIs wait for stdin EOF before flushing pending output.
      try { this.process.stdin?.end(); } catch { /* ignore */ }
      try {
        // On Windows, SIGTERM maps to TerminateProcess (immediate kill).
        // Use SIGINT (Ctrl+C) first for graceful shutdown, then SIGTERM as
        // fallback. On Unix, SIGTERM allows graceful cleanup.
        const gracefulSignal = process.platform === 'win32' ? 'SIGINT' : 'SIGTERM';
        this.process.kill(gracefulSignal);
        // Give it 2 seconds, then force kill
        const killTimer = setTimeout(() => {
          if (this.process) {
            try { this.process.kill('SIGKILL'); } catch { /* ignore */ }
          }
        }, 2000);
        this.process.once('close', () => clearTimeout(killTimer));
      } catch { /* ignore */ }
    }
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    // For subprocess-based backends, subsequent user messages are sent via
    // stdin. Not all CLIs support this — override in subclass if needed.
    this.writeStdin(text);
  }

  sendUserContent(content: UserContentBlock[], _priority?: InputPriority): void {
    // Extract text from content blocks; images are not supported by most
    // subprocess CLIs.
    const text = content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const droppedImages = content.filter((b) => b.type === 'image').length;
    if (droppedImages > 0) {
      console.warn(`[subprocess] sendUserContent dropped ${droppedImages} image(s) — not supported by this backend`);
    }
    if (text) this.sendUserText(text);
  }

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // Subprocess CLIs typically don't support interactive permission flow.
    // Override in subclass if the CLI has a permission protocol.
  }

  async interrupt(): Promise<void> {
    if (this.process && !this.closed) {
      try { this.process.kill('SIGINT'); } catch { /* ignore */ }
    }
  }

  protected writeStdin(data: string): void {
    try {
      if (this.process?.stdin?.writable) {
        this.process.stdin.write(data + '\n');
      }
    } catch {
      // EPIPE / ERR_STREAM_DESTROYED — process died between check and write
    }
  }
}

// ── Subprocess backend base class ──────────────────────────────────────────────
// Extends CliBackend for CLIs that are spawned as subprocesses.

export abstract class SubprocessBackend implements CliBackend {
  abstract readonly id: string;
  abstract readonly capabilities: BackendCapabilities;
  /** Name of the CLI binary (e.g. 'kimi', 'codex'). Used for PATH lookup. */
  abstract readonly binaryName: string;

  /** Subclasses implement: create the session instance. */
  abstract createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession;

  resolveBinary(): string | null {
    return resolveBinaryFromPath(this.binaryName);
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    void auth;
    return isolatedSubprocessEnv(extra);
  }
}

// ── Binary resolution from PATH ────────────────────────────────────────────────
// Tries to find a binary by name: system PATH first, then known locations.

/** Standard binary directories per platform. The Electron main process
 *  launched from a .app bundle often has a minimal or empty PATH — we always
 *  augment the which/where call and the filesystem candidate list with these
 *  locations so freshly-installed CLIs are discoverable without a relaunch. */
function getStandardBinDirs(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (process.platform === 'win32') {
    const dirs: string[] = [];
    // npm global installs
    if (process.env.APPDATA) dirs.push(`${process.env.APPDATA}\\npm`);
    // Scoop
    if (home) dirs.push(`${home}\\scoop\\shims`);
    // Chocolatey
    dirs.push('C:\\ProgramData\\chocolatey\\bin');
    return dirs;
  }
  const dirs = ['/usr/local/bin', '/opt/homebrew/bin'];
  if (home) {
    dirs.push(
      `${home}/.local/bin`,
      `${home}/.bin`,
      `${home}/bin`,
      // Canonical location used by the current Kimi Code installer. Finder-
      // launched .app processes do not source ~/.zshrc, so this must be an
      // explicit candidate rather than relying on the user's interactive PATH.
      `${home}/.kimi-code/bin`,
    );
    // npm global bin when the user has a custom prefix (~/.npm-global is the
    // most common convention; also covers npmrc `prefix` set to ~/.npm-global).
    dirs.push(`${home}/.npm-global/bin`);
  }
  // Dynamically resolve npm global prefix via config (fast — reads ~/.npmrc
  // and built-in defaults without starting the full npm process). Cached
  // after first call so repeated resolutions don't re-spawn.
  const npmBin = resolveNpmGlobalBin();
  if (npmBin && !dirs.includes(npmBin)) dirs.push(npmBin);
  return dirs;
}

/** Resolve the npm global `bin` directory by running `npm config get prefix`.
 *  Returns null if npm isn't available or the command fails. Cached after
 *  first call — the global prefix doesn't change at runtime. */
let npmGlobalBinCache: string | null | undefined;
function resolveNpmGlobalBin(): string | null {
  if (npmGlobalBinCache !== undefined) return npmGlobalBinCache;
  try {
    const lookupCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = execFileSync(lookupCmd, ['config', 'get', 'prefix'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PATH: process.env.PATH },
    });
    const prefix = result.trim();
    if (prefix && existsSync(prefix)) {
      const binDir = process.platform === 'win32' ? prefix : `${prefix}/bin`;
      npmGlobalBinCache = existsSync(binDir) ? binDir : null;
      return npmGlobalBinCache;
    }
  } catch { /* npm not available */ }
  npmGlobalBinCache = null;
  return null;
}

/** Build a PATH string that includes the inherited PATH plus standard dirs. */
export function augmentedPath(): string {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of getStandardBinDirs()) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(delimiter);
}

export function resolveBinaryFromPath(binaryName: string): string | null {
  // Validate binaryName: only alphanumeric, hyphens, underscores, dots allowed
  if (!/^[a-zA-Z0-9._-]+$/.test(binaryName)) {
    return null;
  }

  // 1. Check system PATH via execFileSync (no shell — prevents command injection)
  //    Windows uses `where`, Unix uses `which`.
  try {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(lookupCmd, [binaryName], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PATH: augmentedPath() },
    });
    const found = result.trim().split('\n')[0]?.trim();
    if (found && existsSync(found)) return found;
  } catch { /* not found in PATH */ }

  // 2. Known install locations (platform-specific)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  if (process.platform === 'win32') {
    const winCandidates = [
      // Standard Program Files installs
      `C:\\Program Files\\${binaryName}\\${binaryName}.exe`,
      `C:\\Program Files (x86)\\${binaryName}\\${binaryName}.exe`,
      // User-local installs
      `${process.env.LOCALAPPDATA}\\${binaryName}\\${binaryName}.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\${binaryName}\\${binaryName}.exe`,
      // npm global installs (multiple extensions)
      `${process.env.APPDATA}\\npm\\${binaryName}.cmd`,
      `${process.env.APPDATA}\\npm\\${binaryName}.exe`,
      `${process.env.APPDATA}\\npm\\${binaryName}.ps1`,
      // Scoop shims
      `${home}\\scoop\\shims\\${binaryName}.exe`,
      `${home}\\scoop\\apps\\${binaryName}\\current\\${binaryName}.exe`,
      // Kimi installer canonical location (also used by WSL-compatible
      // Windows developer installs which may ship an extensionless shim).
      `${home}\\.kimi-code\\bin\\${binaryName}`,
      `${home}\\.kimi-code\\bin\\${binaryName}.exe`,
      // Chocolatey
      `C:\\ProgramData\\chocolatey\\bin\\${binaryName}.exe`,
    ];
    for (const candidate of winCandidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  } else {
    // macOS / Linux candidates
    const candidates = [
      `/usr/local/bin/${binaryName}`,
      `/opt/homebrew/bin/${binaryName}`,
      `${home}/.local/bin/${binaryName}`,
      `${home}/.bin/${binaryName}`,
      `${home}/bin/${binaryName}`,
      `${home}/.kimi-code/bin/${binaryName}`,
      // npm global bin when user has custom prefix (~/.npm-global)
      `${home}/.npm-global/bin/${binaryName}`,
      // Homebrew npm global installs on Apple Silicon
      `/opt/homebrew/lib/node_modules/${binaryName}/bin/${binaryName}`,
      // npm global prefix on macOS (Intel) / Linux
      `/usr/local/lib/node_modules/${binaryName}/bin/${binaryName}`,
      `/usr/lib/node_modules/${binaryName}/bin/${binaryName}`,
      // npm global installs under custom prefix
      `${home}/.npm-global/lib/node_modules/${binaryName}/bin/${binaryName}`,
      // Linux-specific
      `/snap/bin/${binaryName}`,
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}
