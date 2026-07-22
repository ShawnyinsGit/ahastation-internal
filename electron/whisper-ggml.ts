// whisper-ggml.ts — ggml backend plugin selection (Phase 6b).
//
// whisper-server's GGML_BACKEND_PATH accepts ONE explicit plugin file (not
// a directory). macOS brew ships per-CPU plugins (libggml-cpu-apple_m1.so
// was hardcoded); the official v1.9.1 linux/windows archives ship generic
// plugins (libggml-cpu.so / ggml-cpu.dll). Selection is pure + testable:
// given the files present in the whisper dir, pick the best backend.

/** Choose the ggml CPU backend plugin for this platform from the available
 *  filenames. Returns null when nothing usable is present (ggml's default
 *  search then applies — do NOT set GGML_BACKEND_PATH). */
export function chooseGgmlBackend(
  files: readonly string[],
  platform: NodeJS.Platform,
): string | null {
  const set = new Set(files);
  if (platform === 'darwin') {
    if (set.has('libggml-cpu-apple_m1.so')) return 'libggml-cpu-apple_m1.so';
    const fallback = files.find((f) => /^libggml-cpu.*\.so$/.test(f));
    return fallback ?? null;
  }
  if (platform === 'linux') {
    if (set.has('libggml-cpu.so')) return 'libggml-cpu.so';
    const fallback = files.find((f) => /^libggml-cpu.*\.so$/.test(f));
    return fallback ?? null;
  }
  if (platform === 'win32') {
    if (set.has('ggml-cpu.dll')) return 'ggml-cpu.dll';
    const fallback = files.find((f) => /^ggml-cpu.*\.dll$/i.test(f));
    return fallback ?? null;
  }
  return null;
}
