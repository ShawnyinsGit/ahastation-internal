// speaker-embedding.worker.ts — dedicated Web Worker for CAM++ inference.
//
// The renderer main thread used to run fbank + ONNX inference inline; every
// voice segment then froze the UI for ~50-100 ms (worse while TTS plays and
// the echo gate embeds each suppressed segment), which users felt as whole-
// app stutter. All heavy work lives here now; the main thread only shuttles
// transferable Float32Arrays.
//
// Protocol (main → worker):
//   { type: 'init', modelUrl, wasmBase }   — URLs resolved on the main thread
//                                            (document.baseURI), which knows
//                                            both dev-server and packaged
//                                            app:// layouts.
//   { type: 'embed', id, samples }         — Float32Array transferred in.
// Replies (worker → main):
//   { type: 'ready' } | { type: 'init-error', message }
//   { type: 'embed-result', id, embedding: Float32Array | null }

import * as ort from 'onnxruntime-web';
import type { InferenceSession } from 'onnxruntime-web';
import { computeFbank } from './fbank';

const MIN_FRAMES_FOR_EMBEDDING = 50; // 0.5s

let session: InferenceSession | null = null;

function l2Normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

async function init(modelUrl: string, wasmBase: string): Promise<void> {
  ort.env.wasm.wasmPaths = wasmBase;
  ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

async function embed(samples: Float32Array): Promise<Float32Array | null> {
  if (!session) return null;
  const { data: fbank, frames } = computeFbank(samples);
  if (frames < MIN_FRAMES_FOR_EMBEDDING) return null;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor('float32', fbank, [1, frames, 80]);
  const result = await session.run({ [inputName]: tensor });
  const raw = result[outputName].data as Float32Array;
  const emb = new Float32Array(raw.length);
  emb.set(raw);
  return l2Normalize(emb);
}

self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg?.type === 'init') {
    init(msg.modelUrl, msg.wasmBase).then(
      () => self.postMessage({ type: 'ready' }),
      (err) => self.postMessage({
        type: 'init-error',
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }
  if (msg?.type === 'embed') {
    const id = msg.id as number;
    const samples = msg.samples as Float32Array;
    embed(samples).then(
      (embedding) => {
        if (embedding) {
          self.postMessage(
            { type: 'embed-result', id, embedding },
            { transfer: [embedding.buffer] },
          );
        } else {
          self.postMessage({ type: 'embed-result', id, embedding: null });
        }
      },
      () => self.postMessage({ type: 'embed-result', id, embedding: null }),
    );
  }
};
