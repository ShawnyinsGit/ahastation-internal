// whisper-server.ts — supervises a bundled whisper.cpp HTTP server so we can
// keep the model resident across calls instead of paying 150–400 ms of cold
// load on every VAD segment.
//
// Lifecycle:
//   1. startWhisperServer() spawns whisper-server on 127.0.0.1:<port>, waits
//      for either the "listening" stdout banner or a successful TCP probe
//      (whichever fires first), then fires a dry-run /inference call with a
//      200 ms 440 Hz tone to compile Metal shaders and prime the model.
//   2. transcribePcm() in whisper.ts checks isWhisperServerReady() and POSTs
//      to /inference; on failure it returns an error and the renderer's next
//      segment naturally retries while we restart the server in the
//      background.
//   3. stopWhisperServer() SIGTERMs the child (1 s grace, then SIGKILL).
//
// If whisper-server isn't bundled (dev tree missing the binary, brew not
// installed), the rest of the ASR path silently falls back to per-call
// whisper-cli — no renderer changes required.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { encodeWavPcm16, resolveWhisperPaths } from './whisper.js';
import { chooseGgmlBackend } from './whisper-ggml.js';

const DEFAULT_PORT = 8723;
const MAX_PORT_TRIES = 5;
const BOOT_TIMEOUT_MS = 20_000;
const STOP_GRACE_MS = 1_000;
const STOP_KILL_WAIT_MS = 200;
// Server-level fetch ceiling. small-q5_1 + greedy decode finishes a 2 s clip
// in ~280 ms on M2, so 10 s comfortably covers the worst outlier without
// letting a wedged request pile up behind it.
const SERVER_FETCH_TIMEOUT_MS = 10_000;
// Restart policy: indefinite small bursts would mask a real bug, so 60 s
// rolling window with 3 attempts is the cap before we mark dead-permanently
// and let the CLI fallback carry the rest of the session.
const RESTART_WINDOW_MS = 60_000;
const RESTART_ATTEMPT_BACKOFFS_MS = [250, 1_000, 4_000];
// Timeout-driven self-restart: if fetch hits SERVER_FETCH_TIMEOUT_MS this
// many times within the same window, the server is presumed wedged and we
// trigger a fresh boot.
const TIMEOUT_RESTART_THRESHOLD = 3;
// Delay before the TCP-connect ready probe fires for the first time. Long
// enough that a bind failure (EADDRINUSE, etc.) has surfaced on stderr,
// short enough that the probe still acts as a real fallback if the stdout
// banner wording drifts upstream.
const PROBE_GRACE_MS = 600;
const MIN_MODEL_BYTES = 1_000_000;
const IDLE_TIMEOUT_MS = 120_000;

type ServerState = {
  child: ChildProcess;
  port: number;
  ready: boolean;
};

let state: ServerState | null = null;
let starting: Promise<StartResult> | null = null;
// Permanent flag — once flipped, no automatic restarts are attempted for the
// rest of the app's lifetime. Cleared only on the next process launch.
let serverDeadPermanently = false;
let restartAttempts: number[] = [];
let timeoutEvents: number[] = [];
let idleTimer: NodeJS.Timeout | null = null;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!state?.ready || serverDeadPermanently) return;
    console.log('[whisper-server] idle for 2min — stopping to reclaim memory');
    void stopWhisperServer(false);
  }, IDLE_TIMEOUT_MS);
}

function clearIdleTimer(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

export type StartResult =
  | { ok: true; port: number }
  | { ok: false; reason: string };

export function isWhisperServerReady(): boolean {
  return !!state?.ready && !serverDeadPermanently;
}

export function getWhisperServerPort(): number | null {
  return state?.ready ? state.port : null;
}

export async function startWhisperServer(): Promise<StartResult> {
  if (state?.ready) return { ok: true, port: state.port };
  if (starting) return starting;
  if (serverDeadPermanently) {
    return { ok: false, reason: 'server marked dead — fallback to whisper-cli for this session' };
  }

  const paths = resolveWhisperPaths();
  if (!paths || !paths.server) {
    return { ok: false, reason: 'whisper-server binary missing — bundled CLI will be used per call' };
  }

  starting = (async () => {
    try {
      return await spawnOnNextFreePort(paths.server!, paths.model, paths.dir, DEFAULT_PORT);
    } finally {
      starting = null;
    }
  })();
  return starting;
}

async function spawnOnNextFreePort(
  serverBin: string,
  modelPath: string,
  cwd: string,
  basePort: number,
): Promise<StartResult> {
  for (let i = 0; i < MAX_PORT_TRIES; i++) {
    const port = basePort + i;
    const res = await spawnOnce(serverBin, modelPath, cwd, port);
    if (res.kind === 'ok') {
      state = { child: res.child, port, ready: false };
      attachExitHandler(res.child, serverBin, modelPath, cwd);
      const warmed = await warmupOrTimeout(port);
      if (state) state.ready = true;
      resetIdleTimer();
      if (!warmed) {
        console.warn('[whisper-server] warmup failed — first segment will be cold');
      } else {
        console.log(`[whisper-server] ready on 127.0.0.1:${port} (warmup ok)`);
      }
      return { ok: true, port };
    }
    if (res.kind === 'port-in-use') {
      console.warn(`[whisper-server] port ${port} in use, trying ${port + 1}`);
      continue;
    }
    return { ok: false, reason: res.reason };
  }
  return { ok: false, reason: `no free port in ${basePort}..${basePort + MAX_PORT_TRIES - 1}` };
}

type SpawnResult =
  | { kind: 'ok'; child: ChildProcess }
  | { kind: 'port-in-use' }
  | { kind: 'failed'; reason: string };

function spawnOnce(
  serverBin: string,
  modelPath: string,
  cwd: string,
  port: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const args = [
      '-m', modelPath,
      '-t', '4',
      '-bs', '1',                  // greedy: beam size 1
      '-bo', '1',                  // greedy: best-of 1
      '-nf',                       // no temperature fallback (avoid 5× retries)
      '-nt',                       // no timestamps
      '-sns',                      // suppress non-speech tokens ([Music], [BLANK_AUDIO], …)
      '-fa',                       // flash-attention (default true; declared explicitly)
      '-l', 'auto',                // default; each request can override
      '--host', '127.0.0.1',
      '--port', String(port),
      '--inference-path', '/inference',
    ];

    const child = spawn(serverBin, args, {
      cwd,
      // Homebrew-built ggml embeds its Cellar libexec as a default search
      // path. GGML_BACKEND_PATH accepts one explicit plugin (not a directory),
      // so provide the baseline Apple Silicon CPU backend shipped beside the
      // server. Machines with the original Cellar can still add Metal/BLAS;
      // clean Macs always retain a self-contained CPU path.
      env: whisperServerEnv(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolved = false;
    let stderrBuf = '';
    let probeTimer: NodeJS.Timeout | null = null;
    let probeStart: NodeJS.Timeout | null = null;
    let bootTimer: NodeJS.Timeout | null = null;
    let activeProbe: net.Socket | null = null;

    const cancelProbe = () => {
      if (probeStart) { clearTimeout(probeStart); probeStart = null; }
      if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
      if (activeProbe) { try { activeProbe.destroy(); } catch { /* ignore */ } activeProbe = null; }
    };

    const done = (r: SpawnResult) => {
      if (resolved) return;
      resolved = true;
      cancelProbe();
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      resolve(r);
    };

    // Dual ready signal: either the stdout banner ("listening at …") OR a
    // successful TCP connect to the configured port. Belt-and-braces against
    // upstream whisper.cpp changing the log wording — the binary still has to
    // open the socket either way.
    //
    // We delay the first probe by PROBE_GRACE_MS so a bind failure has time
    // to surface on stderr (and trip the EADDRINUSE branch below) before we
    // mistake an unrelated process already listening on this port for a
    // freshly-bound whisper-server.
    const probeOnce = () => {
      if (resolved) return;
      const sock = net.createConnection({ port, host: '127.0.0.1' });
      activeProbe = sock;
      sock.setTimeout(200);
      const cleanup = () => {
        if (activeProbe === sock) activeProbe = null;
        try { sock.destroy(); } catch { /* ignore */ }
      };
      sock.once('connect', () => {
        cleanup();
        if (!resolved) done({ kind: 'ok', child });
      });
      sock.once('error', cleanup);
      sock.once('timeout', cleanup);
    };
    probeStart = setTimeout(() => {
      probeStart = null;
      if (resolved) return;
      probeOnce();
      probeTimer = setInterval(probeOnce, 250);
    }, PROBE_GRACE_MS);

    const onLine = (chunk: Buffer) => {
      const text = chunk.toString();
      // Forward to console so verify-latency can grep main-process logs.
      process.stdout.write(`[whisper-server] ${text}`);
      if (!resolved && /listening at/i.test(text)) {
        done({ kind: 'ok', child });
      }
    };

    const onErr = (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      process.stderr.write(`[whisper-server] ${text}`);
      // whisper-server doesn't always exit on bind failure — sometimes it
      // logs the address-in-use error and lingers. Sniff for it explicitly
      // so we can retry the next port without waiting for the full boot
      // timeout.
      if (!resolved && /address already in use|EADDRINUSE|bind/i.test(text)) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        done({ kind: 'port-in-use' });
      }
    };

    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onErr);

    child.once('error', (e) => {
      done({ kind: 'failed', reason: `spawn error: ${String(e?.message ?? e)}` });
    });
    child.once('exit', (code) => {
      if (!resolved) {
        done({ kind: 'failed', reason: `exit ${code} during boot — stderr: ${stderrBuf.slice(-400)}` });
      }
    });

    bootTimer = setTimeout(() => {
      if (!resolved) {
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        done({ kind: 'failed', reason: `boot timeout after ${BOOT_TIMEOUT_MS} ms` });
      }
    }, BOOT_TIMEOUT_MS);
  });
}

export function whisperServerEnv(cwd: string): NodeJS.ProcessEnv {
  // GGML_BACKEND_PATH takes ONE plugin file. macOS brew ships
  // libggml-cpu-apple_m1.so; official linux/win archives ship generic
  // libggml-cpu.so / ggml-cpu.dll. Pick whatever actually exists; when no
  // plugin is found, leave the var unset so ggml's default search applies
  // instead of pointing at a file that isn't there.
  const backend = chooseGgmlBackend(readdirSync(cwd), process.platform);
  if (!backend) return { ...process.env };
  return { ...process.env, GGML_BACKEND_PATH: join(cwd, backend) };
}

function attachExitHandler(child: ChildProcess, serverBin: string, modelPath: string, cwd: string): void {
  child.once('exit', (code) => {
    if (!state || state.child !== child) return; // superseded
    const wasReady = state.ready;
    state = null;
    if (serverDeadPermanently) {
      console.warn(`[whisper-server] exited (code=${code}); not restarting — marked dead`);
      return;
    }
    console.warn(`[whisper-server] exited (code=${code}, wasReady=${wasReady}) — attempting restart`);
    void restartWithBackoff(serverBin, modelPath, cwd).catch((err) => {
      console.error('[whisper-server] unexpected restart error:', err);
    });
  });
}

type AssetCheck = { ok: true } | { ok: false; reason: string };

// Fast on-disk sanity check for the assets the server needs. Used after the
// first restart failure so a missing/truncated binary or model surfaces a
// clear error immediately instead of hiding behind a full backoff cycle.
function validateWhisperAssets(serverBin: string, modelPath: string): AssetCheck {
  if (!existsSync(serverBin)) {
    return { ok: false, reason: `whisper-server binary missing at ${serverBin}` };
  }
  if (!existsSync(modelPath)) {
    return { ok: false, reason: `model missing at ${modelPath}` };
  }
  try {
    const binStat = statSync(serverBin);
    if (binStat.size === 0) {
      return { ok: false, reason: `whisper-server binary is zero bytes: ${serverBin}` };
    }
    const modelStat = statSync(modelPath);
    if (modelStat.size < MIN_MODEL_BYTES) {
      return {
        ok: false,
        reason: `model truncated (${modelStat.size} bytes, expected ≥ ${MIN_MODEL_BYTES}): ${modelPath}`,
      };
    }
  } catch (e) {
    return { ok: false, reason: `stat failed: ${String((e as Error)?.message ?? e)}` };
  }
  return { ok: true };
}

async function restartWithBackoff(serverBin: string, modelPath: string, cwd: string): Promise<void> {
  pruneOldEvents(restartAttempts);
  if (restartAttempts.length >= RESTART_ATTEMPT_BACKOFFS_MS.length) {
    serverDeadPermanently = true;
    console.error(
      `[whisper-server] ${restartAttempts.length} restarts in ${RESTART_WINDOW_MS / 1000}s — marking dead, ` +
        `falling back to whisper-cli for the rest of this session`,
    );
    return;
  }
  const delay = RESTART_ATTEMPT_BACKOFFS_MS[restartAttempts.length];
  restartAttempts.push(Date.now());
  await sleep(delay);
  if (serverDeadPermanently) return;
  const res = await spawnOnNextFreePort(serverBin, modelPath, cwd, DEFAULT_PORT);
  if (!res.ok) {
    console.warn(`[whisper-server] restart failed: ${res.reason}`);
    // After the first restart failure, sanity-check the on-disk assets. If
    // the binary or model is missing/truncated, no amount of backoff will
    // help — surface the real problem and stop the retry storm immediately
    // instead of waiting for the third strike to mark dead.
    if (restartAttempts.length === 1) {
      const check = validateWhisperAssets(serverBin, modelPath);
      if (!check.ok) {
        serverDeadPermanently = true;
        console.error(
          `[whisper-server] asset check failed after first restart: ${check.reason} — marking dead, ` +
            `falling back to whisper-cli for the rest of this session`,
        );
        return;
      }
    }
    void restartWithBackoff(serverBin, modelPath, cwd).catch((err) => {
      console.error('[whisper-server] unexpected restart error:', err);
    });
  }
}

// 200 ms / 16 kHz / 440 Hz / 0.05 amplitude sine. Non-silent on purpose:
// silent input lets whisper.cpp shortcut to an empty result before the full
// attention path runs, which means Metal shaders never compile during the
// warmup window and the *first real user segment* eats the 150–400 ms cold
// hit. A quiet tone forces the encoder + decoder to fully traverse so the
// shader cache is hot when real speech arrives. `-sns` in the server args
// suppresses any non-speech tokens the tone might produce, so we don't have
// to scrub phantom transcript text.
function buildWarmupTone(): Float32Array {
  const sampleRate = 16_000;
  const lengthSamples = 3_200;
  const freqHz = 440;
  const amp = 0.05;
  const out = new Float32Array(lengthSamples);
  const w = (2 * Math.PI * freqHz) / sampleRate;
  for (let i = 0; i < lengthSamples; i++) {
    out[i] = amp * Math.sin(w * i);
  }
  return out;
}

// Fire a tiny non-silent inference so Metal shaders compile and the model
// lands in page cache before the first user segment. Caller MUST await this:
// `state.ready = true` is only flipped after the await returns, otherwise
// `isWhisperServerReady()` could go true while the GPU is still compiling.
async function warmupOrTimeout(port: number): Promise<boolean> {
  try {
    const tone = buildWarmupTone();
    await postInference(port, tone, 'auto', 5_000);
    return true;
  } catch (e) {
    console.warn('[whisper-server] warmup error:', (e as Error)?.message ?? e);
    return false;
  }
}

// Public helper used by whisper.ts's runOnServer path.
export async function postInference(
  port: number,
  pcm: Float32Array,
  lang: 'auto' | 'zh' | 'en',
  timeoutMs: number = SERVER_FETCH_TIMEOUT_MS,
): Promise<string> {
  resetIdleTimer();
  const wav = encodeWavPcm16(pcm);
  // Node's global Blob accepts Buffer directly (BinaryLike includes
  // ArrayBufferView; Buffer is a Uint8Array). No DOM lib types needed.
  const form = new FormData();
  form.set('file', new Blob([wav], { type: 'audio/wav' }), 'seg.wav');
  form.set('response_format', 'text');
  form.set('language', lang);
  form.set('temperature', '0.0');
  form.set('no_timestamps', 'true');

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/inference`, {
      method: 'POST',
      body: form,
      signal: ac.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const text = await resp.text();
    return text.trim();
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      recordTimeout();
      throw new Error(`whisper-server timeout after ${timeoutMs} ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function recordTimeout(): void {
  pruneOldEvents(timeoutEvents);
  timeoutEvents.push(Date.now());
  if (timeoutEvents.length >= TIMEOUT_RESTART_THRESHOLD) {
    console.warn(
      `[whisper-server] ${timeoutEvents.length} timeouts in ${RESTART_WINDOW_MS / 1000}s — bouncing server`,
    );
    timeoutEvents = [];
    // Kill the current child; the exit handler will trigger the restart loop.
    void stopForRestart();
  }
}

async function stopForRestart(): Promise<void> {
  const s = state;
  if (!s) return;
  try { s.child.kill('SIGTERM'); } catch { /* ignore */ }
}

function pruneOldEvents(buf: number[]): void {
  const cutoff = Date.now() - RESTART_WINDOW_MS;
  while (buf.length > 0 && buf[0] < cutoff) buf.shift();
}

export async function stopWhisperServer(permanent: boolean = true): Promise<void> {
  clearIdleTimer();
  if (!state) return;
  const s = state;
  state = null;
  // Block auto-restart from the exit handler: a quit-time SIGTERM must not
  // race the restart loop and leave a zombie child around app.exit(). On the
  // macOS window-close path we pass permanent=false so a later `activate` can
  // revive the server; the exit handler is still superseded (state is null)
  // so no auto-restart fires either way.
  if (permanent) serverDeadPermanently = true;
  try { s.child.kill('SIGTERM'); } catch { /* ignore */ }
  await sleep(STOP_GRACE_MS);
  if (!s.child.killed) {
    try { s.child.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(STOP_KILL_WAIT_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
