// opencode-server-process.ts — self-managed `opencode serve` child process.
//
// Why not the SDK's createOpencode(): it spawns `opencode` from PATH with
// `...process.env` inherited wholesale (leaking every secret in our env to
// the child) and has no auth support. We instead (all from spike §1–§3):
//   - resolve the bundled platform binary (opencode-<platform>-<arch>),
//   - pass a WHITELISTED environment — never process.env wholesale,
//   - set a per-launch random OPENCODE_SERVER_PASSWORD (native HTTP Basic
//     auth covering every endpoint including SSE; username defaults to
//     "opencode"),
//   - parse the listening banner with a FULL-TEXT regex (a warning line may
//     precede it), then poll /global/health (with auth) for liveness,
//   - SIGTERM for shutdown (verified clean, no child processes, on macOS).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export function generateServerPassword(): string {
  // 24 random bytes → 32 base64url chars (192 bits of entropy).
  return randomBytes(24).toString('base64url');
}

export function basicAuthHeader(password: string, username = 'opencode'): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function parseServerBanner(output: string): string | null {
  // Full-text scan — never trust first/last line positions: stdout may carry
  // a leading warning line before the banner (spike §2).
  const m = /opencode server listening on\s+(https?:\/\/[^\s]+)/i.exec(output);
  return m ? m[1] : null;
}

const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  'TERM', 'COLORTERM', 'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
] as const;

export interface ServerEnvOptions {
  password: string;
  /** Pinned server config, serialized into OPENCODE_CONFIG_CONTENT. */
  config?: Record<string, unknown>;
  /** Explicit provider credentials. Only values deliberately handed in here
   *  reach the server — secrets that merely happen to exist in our own
   *  process.env (ANTHROPIC_API_KEY etc.) never leak through. */
  providerEnv?: NodeJS.ProcessEnv;
  /** Injectable for tests. Defaults to process.env. */
  baseEnv?: NodeJS.ProcessEnv;
}

export function buildServerEnv(opts: ServerEnvOptions): NodeJS.ProcessEnv {
  const base = opts.baseEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_WHITELIST) {
    const value = base[key];
    if (typeof value === 'string') env[key] = value;
  }
  env.OPENCODE_SERVER_PASSWORD = opts.password;
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(opts.config ?? {});
  if (opts.providerEnv) Object.assign(env, opts.providerEnv);
  return env;
}

// ── Custom provider config (OPENCODE_CONFIG_CONTENT provider section) ───────
//
// opencode validates model IDs against its built-in registry (models.dev), so
// a model like `kimi/k3` dies with ProviderModelNotFoundError before any API
// call (spike 2026-07-22, observed in the server log as a silent turn stall).
// Non-built-in providers must be declared in the config's `provider` section.
// We derive that declaration entirely from the providerEnv convention the
// adapter's buildEnv already produces:
//   <X>_API_KEY + <X>_BASE_URL        → provider id x (lowercased)
//   AHAMEET_OPENCODE_MODEL = "x/model" → the model ID to register
// Built-in providers (OPENAI/ANTHROPIC) never need this and are skipped.

const BUILTIN_PROVIDER_KEYS = new Set(['OPENAI', 'ANTHROPIC']);

export interface CustomProviderConfig {
  provider: Record<string, {
    npm: string;
    name: string;
    options: { baseURL: string; apiKey: string };
    models: Record<string, { name: string }>;
  }>;
}

export function deriveCustomProviderConfig(
  providerEnv: NodeJS.ProcessEnv | undefined,
): Record<string, never> | CustomProviderConfig {
  if (!providerEnv) return {};
  const model = providerEnv.AHAMEET_OPENCODE_MODEL ?? '';
  const modelProvider = model.split('/')[0]?.toLowerCase() ?? '';
  const modelId = model.includes('/') ? model.split('/').slice(1).join('/') : '';

  const out: CustomProviderConfig['provider'] = {};
  for (const key of Object.keys(providerEnv)) {
    const m = /^([A-Z0-9_]+)_API_KEY$/.exec(key);
    if (!m) continue;
    const prefix = m[1];
    if (BUILTIN_PROVIDER_KEYS.has(prefix)) continue;
    const baseUrl = providerEnv[`${prefix}_BASE_URL`];
    const providerId = prefix.toLowerCase();
    // Only register the provider the selected model actually belongs to —
    // a key without a matching model would produce a config that validates
    // but still cannot serve the prompt.
    if (!baseUrl || providerId !== modelProvider || !modelId) continue;
    out[providerId] = {
      npm: '@ai-sdk/openai-compatible',
      name: providerId,
      options: { baseURL: baseUrl, apiKey: `{env:${prefix}_API_KEY}` },
      models: { [modelId]: { name: modelId } },
    };
  }
  return Object.keys(out).length > 0 ? { provider: out } : {};
}

// ── Binary resolution ───────────────────────────────────────────────────────

function unpackify(p: string): string {
  return p.replace(/[\\/]app\.asar[\\/]/, (_, sep) => `${sep}app.asar.unpacked${sep}`);
}

/** Real path of the bundled opencode binary, or null when the platform
 *  package is not installed. (Replaces the old 'sdk' sentinel.) */
export function resolveOpencodeBinary(): string | null {
  const platform = process.platform; // darwin | linux | win32
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  // Upstream names the Windows package "windows", not "win32".
  const osName = platform === 'win32' ? 'windows' : platform;
  // TODO(cross-platform): linux x64 needs the AVX2/musl variant selection
  // from spike §1 (baseline packages) when we ship linux targets.
  const pkg = `opencode-${osName}-${arch}`;
  const binName = platform === 'win32' ? 'opencode.exe' : 'opencode';

  // Dev / unpacked layout: node_modules/<pkg>/bin/opencode
  try {
    const require_ = createRequire(import.meta.url);
    const p = unpackify(require_.resolve(`${pkg}/bin/${binName}`));
    if (existsSync(p)) return p;
  } catch { /* package not installed — fall through */ }

  // Packaged layout (electron-builder asarUnpack: **/node_modules/opencode-*/bin/**)
  const guesses = [
    process.resourcesPath && `${process.resourcesPath}/app.asar.unpacked/node_modules/${pkg}/bin/${binName}`,
  ].filter((x): x is string => !!x);
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  return null;
}

// ── Process handle ──────────────────────────────────────────────────────────

export interface OpencodeServerHandle {
  url: string;
  password: string;
  pid: number | null;
  kill(): void;
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface SpawnServerOptions {
  cwd: string;
  /** Override for tests / Phase 3 registry; defaults to resolveOpencodeBinary(). */
  binaryPath?: string | null;
  /** Override for tests; defaults to a fresh random password per launch. */
  password?: string;
  config?: Record<string, unknown>;
  providerEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

async function waitForHealth(url: string, password: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/global/health`, {
        headers: { authorization: basicAuthHeader(password) },
      });
      if (res.ok) return;
      lastErr = new Error(`health HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`opencode server did not become healthy: ${String(lastErr)}`);
}

export async function spawnOpencodeServer(opts: SpawnServerOptions): Promise<OpencodeServerHandle> {
  const binary = opts.binaryPath === undefined ? resolveOpencodeBinary() : opts.binaryPath;
  if (!binary) {
    throw new Error(`OpenCode binary not found (opencode-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch} not installed)`);
  }
  const password = opts.password ?? generateServerPassword();
  const timeoutMs = opts.timeoutMs ?? 15000;

  const proc: ChildProcess = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port=0'], {
    cwd: opts.cwd,
    env: buildServerEnv({ password, config: opts.config, providerEnv: opts.providerEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const url = await new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      proc.off('exit', onExitEarly);
      proc.stdout?.off('data', onData);
      proc.stderr?.off('data', onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      proc.kill('SIGTERM');
      reject(new Error(`Timed out waiting for opencode server banner. Output tail: ${output.slice(-500)}`));
    }, timeoutMs);
    const onExitEarly = () => {
      cleanup();
      reject(new Error(`opencode server exited before banner. Output tail: ${output.slice(-500)}`));
    };
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const found = parseServerBanner(output);
      if (found) {
        cleanup();
        resolve(found);
      }
    };
    proc.once('exit', onExitEarly);
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
  });

  try {
    await waitForHealth(url, password, timeoutMs);
  } catch (err) {
    proc.kill('SIGTERM');
    throw err;
  }

  return {
    url,
    password,
    pid: proc.pid ?? null,
    kill() {
      if (proc.killed) return;
      // TODO(windows): SIGTERM is a no-op on win32 — needs taskkill /T or the
      // SDK's stop() helper when we support Windows. Linux follows POSIX like
      // macOS but is unverified (spike §2 was macOS-only).
      try {
        proc.kill('SIGTERM');
      } catch { /* already gone */ }
    },
    onExit(cb) {
      proc.on('exit', cb);
    },
  };
}
