// speaker-embedding.ts — lazy ONNX speaker embedding extractor (CAM++).
//
// Loads the 3D-Speaker CAM++ ONNX model via onnxruntime-web, reusing the
// same wasm runtime that @ricky0123/vad-web already pulled into public/vad/.
// Exposes a single `embed(samples) → Float32Array` plus a cosine helper for
// the voice-lock gate in useVoiceCapture.
//
// Threading: inference runs in a dedicated Web Worker
// (speaker-embedding.worker.ts). Before the split, fbank + ONNX ran inline
// on the renderer main thread — every voice segment froze the UI ~50-100 ms,
// and while TTS played the echo gate embedded each suppressed segment, which
// users felt as sustained whole-app stutter. If the Worker cannot be created
// or initialized (exotic packaged-protocol edge), we fall back to the old
// inline path so voice-lock keeps working rather than silently failing open.
//
// Heavy: only initialized when something actually requests an embedding,
// not on app startup. ~28 MB model + ~20-50 MB wasm runtime, ~500 ms first
// hit, sub-100 ms per segment after warm-up (off the main thread).
//
// onnxruntime-web and fbank are dynamic-imported so they don't inflate the
// main bundle — the ~400 KB ORT JS bindings + fft.js only load when voice-lock
// is actually used.

import type { InferenceSession } from 'onnxruntime-web';

export const SPEAKER_MODEL_ID = '3dspeaker-campplus-v1';
const MODEL_URL = new URL('voice-id/3dspeaker_campplus_sv_zh_en_16k.onnx', document.baseURI).href;
const WASM_BASE = new URL('vad/', document.baseURI).href;

const MIN_FRAMES_FOR_EMBEDDING = 50; // 0.5s

// ── Worker client ──────────────────────────────────────────────────────────

type EmbedResolver = (embedding: Float32Array | null) => void;

interface WorkerState {
  worker: Worker;
  ready: boolean;
  nextId: number;
  pending: Map<number, EmbedResolver>;
}

let workerState: WorkerState | null = null;
let workerInitPromise: Promise<WorkerState | null> | null = null;

function createWorkerState(): Promise<WorkerState | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./speaker-embedding.worker.ts', import.meta.url), {
        type: 'module',
      });
    } catch {
      resolve(null);
      return;
    }
    const state: WorkerState = { worker, ready: false, nextId: 1, pending: new Map() };
    const initTimer = setTimeout(() => {
      // Init hung (model fetch stalled etc.) — treat as unavailable.
      worker.terminate();
      resolve(null);
    }, 30_000);
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'ready') {
        state.ready = true;
        clearTimeout(initTimer);
        resolve(state);
        return;
      }
      if (msg?.type === 'init-error') {
        clearTimeout(initTimer);
        worker.terminate();
        console.warn('[speaker-embedding] worker init failed, falling back to main thread:', msg.message);
        resolve(null);
        return;
      }
      if (msg?.type === 'embed-result') {
        const resolveEmbed = state.pending.get(msg.id);
        if (resolveEmbed) {
          state.pending.delete(msg.id);
          resolveEmbed(msg.embedding ?? null);
        }
      }
    };
    worker.onerror = () => {
      // Worker script itself failed to load/execute — mark dead. Pending
      // callers get null; future calls take the main-thread fallback.
      for (const resolveEmbed of state.pending.values()) resolveEmbed(null);
      state.pending.clear();
      if (!state.ready) {
        clearTimeout(initTimer);
        resolve(null);
      }
      workerState = null;
    };
    worker.postMessage({ type: 'init', modelUrl: MODEL_URL, wasmBase: WASM_BASE });
  });
}

async function getWorker(): Promise<WorkerState | null> {
  if (workerState?.ready) return workerState;
  if (!workerInitPromise) {
    workerInitPromise = createWorkerState().then((state) => {
      workerState = state;
      workerInitPromise = null;
      return state;
    });
  }
  return workerInitPromise;
}

function embedInWorker(state: WorkerState, samples: Float32Array): Promise<Float32Array | null> {
  // Copy before transfer — transferring the caller's buffer would detach it
  // out from under useVoiceCapture, which keeps referencing `audio`.
  const copy = samples.slice();
  return new Promise((resolve) => {
    const id = state.nextId++;
    state.pending.set(id, resolve);
    state.worker.postMessage({ type: 'embed', id, samples: copy }, { transfer: [copy.buffer] });
  });
}

// ── Main-thread fallback (original inline path) ────────────────────────────

let ortModule: typeof import('onnxruntime-web') | null = null;

async function getOrt(): Promise<typeof import('onnxruntime-web')> {
  if (!ortModule) ortModule = await import('onnxruntime-web');
  return ortModule;
}

let sessionPromise: Promise<InferenceSession> | null = null;

async function getSession(): Promise<InferenceSession> {
  if (sessionPromise) return sessionPromise;
  const ort = await getOrt();
  ort.env.wasm.wasmPaths = WASM_BASE;
  ort.env.wasm.numThreads = 1;
  sessionPromise = ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  return sessionPromise;
}

async function embedInline(samples: Float32Array): Promise<Float32Array | null> {
  const { computeFbank } = await import('./fbank');
  const { data: fbank, frames } = computeFbank(samples);
  if (frames < MIN_FRAMES_FOR_EMBEDDING) return null;

  const ort = await getOrt();
  const session = await getSession();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const tensor = new ort.Tensor('float32', fbank, [1, frames, 80]);
  const result = await session.run({ [inputName]: tensor });
  const raw = result[outputName].data as Float32Array;
  const emb = new Float32Array(raw.length);
  emb.set(raw);
  return l2Normalize(emb);
}

// ── Public API (unchanged) ─────────────────────────────────────────────────

export function prewarmSpeakerModel(): Promise<void> {
  return getWorker()
    .then((state) => (state ? undefined : getSession().then(() => undefined)))
    .catch((e) => {
      sessionPromise = null;
      workerState = null;
      throw e;
    });
}

export async function releaseSpeakerModel(): Promise<void> {
  if (workerState) {
    workerState.worker.terminate();
    workerState = null;
  }
  if (!sessionPromise) return;
  try {
    const session = await sessionPromise;
    await session.release();
  } catch { /* ignore */ }
  sessionPromise = null;
}

export async function embedSpeaker(samples: Float32Array): Promise<Float32Array | null> {
  const state = await getWorker();
  if (state) return embedInWorker(state, samples);
  return embedInline(samples);
}

function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

export function averageEmbeddings(embeddings: Float32Array[]): Float32Array | null {
  if (embeddings.length === 0) return null;
  const dim = embeddings[0].length;
  const sum = new Float32Array(dim);
  for (const e of embeddings) {
    if (e.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += e[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= embeddings.length;
  return l2Normalize(sum);
}
