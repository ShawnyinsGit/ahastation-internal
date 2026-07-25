// mic-level.ts — module-level mic amplitude channel. The VAD fires per audio
// frame (30-100x/sec), which is far too hot for React state: routing the level
// through this emitter keeps the App tree out of the render loop entirely.
// MicMeter subscribes here and writes the fill width directly to the DOM on a
// rAF throttle.

export type MicLevelListener = (level: number) => void;

let level = 0;
const listeners = new Set<MicLevelListener>();

export function setMicLevel(next: number): void {
  level = next;
  for (const listener of listeners) listener(next);
}

export function getMicLevel(): number {
  return level;
}

export function subscribeMicLevel(listener: MicLevelListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
