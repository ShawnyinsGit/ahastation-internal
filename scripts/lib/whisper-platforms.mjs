// whisper-platforms.mjs — pure platform → whisper.cpp asset mapping (Phase 6b).
//
// x64 uses the OFFICIAL whisper.cpp v1.9.1 prebuilt archives (one archive
// bundles whisper-cli + whisper-server + ggml libs). The old per-binary
// v1.7.4-style URLs 404 — these asset names were verified live
// (2026-07-21, HTTP 200; linux-arm64 added 2026-07-24):
//   whisper-bin-ubuntu-x64.tar.gz    (linux x64)
//   whisper-bin-x64.zip              (windows x64)
//   whisper-bin-ubuntu-arm64.tar.gz  (linux arm64 — official since v1.9.1;
//                                     linked against ubuntu-22.04 glibc 2.35,
//                                     needs Debian 12 / Ubuntu 22.04+)
// darwin-arm64 keeps the Homebrew path (no official macOS prebuilt) and
// returns null here. Shared by fetch-whisper.mjs and the asset assertion;
// imported directly by node tests.

export const WHISPER_VERSION = 'v1.9.1';

export const MODEL_NAME = 'ggml-small-q5_1.bin';
export const MODEL_SIZE = 190_085_487; // verified from upstream Content-Length
export const MODEL_MIN_SIZE = MODEL_SIZE - 1_000_000;

const RELEASE_BASE = 'https://github.com/ggerganov/whisper.cpp/releases/download';

/** The official prebuilt archive for a platform/arch, or null when no
 *  official build exists (darwin → Homebrew; win32-arm64 → none). */
export function whisperArchiveFor(platform, arch) {
  if (platform === 'linux') {
    return arch === 'arm64'
      ? `${RELEASE_BASE}/${WHISPER_VERSION}/whisper-bin-ubuntu-arm64.tar.gz`
      : `${RELEASE_BASE}/${WHISPER_VERSION}/whisper-bin-ubuntu-x64.tar.gz`;
  }
  if (platform === 'win32' && arch === 'x64') {
    return `${RELEASE_BASE}/${WHISPER_VERSION}/whisper-bin-x64.zip`;
  }
  return null;
}

/** Binary filename for this platform ('.exe' on win32). */
export function whisperBinaryName(base, platform) {
  return platform === 'win32' ? `${base}.exe` : base;
}
