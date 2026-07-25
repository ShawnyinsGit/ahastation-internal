// Durable on-disk cache for prebuild assets (speaker model, etc.).
// Survives `rm -rf build/`, fresh git checkouts, and CI runs that don't preserve
// the project tree. Override the location with VIBE_MEET_CACHE_DIR. Bust the
// cache by deleting the directory.

import { copyFileSync, linkSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

const CACHE_ROOT = (() => {
  if (process.env.VIBE_MEET_CACHE_DIR) return process.env.VIBE_MEET_CACHE_DIR;
  const p = platform();
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'vibe-meet');
  }
  if (p === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'vibe-meet');
  }
  const xdg = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(xdg, 'vibe-meet');
})();

export function cachePath(...segments) {
  return join(CACHE_ROOT, ...segments);
}

export function ensureCacheDir(...segments) {
  const dir = cachePath(...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileSize(path) {
  try { return statSync(path).size; } catch { return -1; }
}

// Place cacheFile at destFile. Prefer hardlink (instant, no extra disk); fall
// back to copy on cross-device or filesystem-without-hardlinks. Safe only when
// destFile is treated as read-only — writers must use a fresh copy.
export function materializeFromCache(cacheFile, destFile) {
  mkdirSync(dirname(destFile), { recursive: true });
  try { unlinkSync(destFile); } catch { /* missing is fine */ }
  try {
    linkSync(cacheFile, destFile);
    return 'link';
  } catch {
    copyFileSync(cacheFile, destFile);
    return 'copy';
  }
}

// Mirror a freshly-downloaded file into the cache.
export function archiveToCache(srcFile, cacheFile) {
  mkdirSync(dirname(cacheFile), { recursive: true });
  try { unlinkSync(cacheFile); } catch { /* missing is fine */ }
  try {
    linkSync(srcFile, cacheFile);
    return 'link';
  } catch {
    copyFileSync(srcFile, cacheFile);
    return 'copy';
  }
}
