// pcm16.ts - PCM helpers shared by the Xunfei streaming ASR implementation and tests.

/** Convert normalized Float32 audio to signed 16-bit little-endian PCM. */
export function float32ToPcm16(samples: Float32Array): Buffer {
  const pcm = Buffer.allocUnsafe(samples.length * Int16Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    pcm.writeInt16LE(Math.round(value), i * Int16Array.BYTES_PER_ELEMENT);
  }
  return pcm;
}
