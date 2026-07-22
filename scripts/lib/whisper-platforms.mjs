// whisper-platforms.mjs — pure platform → whisper.cpp asset mapping (Phase 6b).
//
// x64 uses the OFFICIAL whisper.cpp v1.9.1 prebuilt archives (one archive
// bundles whisper-cli + whisper-server + ggml libs). The old per-binary
// v1.7.4-style URLs 404 — these asset names were verified live
// (2026-07-21, HTTP 200):
//   whisper-bin-ubuntu-x64.tar.gz  (linux x64)
//   whisper-bin-x64.zip            (windows x64)
// darwin-arm64 keeps the Homebrew path (no official macOS prebuilt),
// linux-arm64 must self-build (official prebuilts are x64-only) — both
// return null here. Shared by fetch-whisper.mjs and the asset assertion;
// imported directly by node tests.

export const WHISPER_VERSION = 'v1.9.1';

export const MODEL_NAME = 'ggml-small-q5_1.bin';
export const MODEL_SIZE = 190_085_487; // verified from upstream Content-Length
export const MODEL_MIN_SIZE = MODEL_SIZE - 1_000_000;

const RELEASE_BASE = 'https://github.com/ggerganov/whisper.cpp/releases/download';

/** The official prebuilt archive for a platform/arch, or null when no
 *  official build exists (darwin → Homebrew; arm64 → self-build). */
export function whisperArchiveFor(platform, arch) {
  if (arch !== 'x64') return null;
  if (platform === 'linux') {
    return `${RELEASE_BASE}/${WHISPER_VERSION}/whisper-bin-ubuntu-x64.tar.gz`;
  }
  if (platform === 'win32') {
    return `${RELEASE_BASE}/${WHISPER_VERSION}/whisper-bin-x64.zip`;
  }
  return null;
}

/** Binary filename for this platform ('.exe' on win32). */
export function whisperBinaryName(base, platform) {
  return platform === 'win32' ? `${base}.exe` : base;
}
