#!/usr/bin/env node
// Acquires whisper.cpp assets (whisper-cli binary + ggml-small-q5_1.bin model)
// into build/whisper/. Idempotent — skips files that already exist with a
// plausible size. Designed to tolerate flaky CN networks.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, copyFileSync, chmodSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { cachePath, ensureCacheDir, materializeFromCache } from './lib/asset-cache.mjs';
import {
  MODEL_MIN_SIZE,
  MODEL_NAME,
  MODEL_SIZE,
  whisperArchiveFor,
  whisperBinaryName,
} from './lib/whisper-platforms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const outDir = join(repoRoot, 'build', 'whisper');

// Platform and architecture detection for cross-platform binary acquisition
const platform = process.platform;
const arch = process.arch; // 'x64' | 'arm64'

const MODEL_MIRRORS = [
  `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`,
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`,
];

const BREW_CANDIDATES = {
  'whisper-cli': [
    '/opt/homebrew/opt/whisper-cpp/bin/whisper-cli',
    '/usr/local/opt/whisper-cpp/bin/whisper-cli',
  ],
  'whisper-server': [
    '/opt/homebrew/opt/whisper-cpp/bin/whisper-server',
    '/usr/local/opt/whisper-cpp/bin/whisper-server',
  ],
};

function log(msg) {
  process.stdout.write(`[fetch-whisper] ${msg}\n`);
}

function which(cmd) {
  // Windows uses `where` instead of `which`
  const tool = platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(tool, [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n')[0].trim() : null;
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

async function downloadWithCurl(url, dest) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const p = spawn(
      'curl',
      [
        '-fL',
        '--retry', '3',
        '--retry-delay', '2',
        '--continue-at', '-',
        '--connect-timeout', '20',
        '--progress-bar',
        '-o', tmp,
        url,
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    p.on('exit', (code) => {
      if (code === 0) {
        try {
          // rename .part → final (cross-platform, no shell needed)
          if (existsSync(dest)) unlinkSync(dest);
          renameSync(tmp, dest);
          resolve();
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(`curl exited ${code} for ${url}`));
      }
    });
    p.on('error', reject);
  });
}

async function ensureModel() {
  const dest = join(outDir, MODEL_NAME);
  if (fileSize(dest) >= MODEL_MIN_SIZE) {
    log(`model ok (${(fileSize(dest) / 1e6).toFixed(1)} MB) — skip`);
    return;
  }

  // Reuse a previously-downloaded copy from the durable cache before hitting the network.
  const cached = cachePath('whisper', MODEL_NAME);
  if (fileSize(cached) >= MODEL_MIN_SIZE) {
    const how = materializeFromCache(cached, dest);
    log(`model restored from cache (${how}): ${cached}`);
    return;
  }

  ensureCacheDir('whisper');
  for (const url of MODEL_MIRRORS) {
    log(`downloading model from ${url}`);
    try {
      // Download into the cache, then materialize into the build dir. That
      // way the next `npm run dist:dmg` (even after `rm -rf build/`) skips
      // the 190 MB pull.
      await downloadWithCurl(url, cached);
      const size = fileSize(cached);
      if (size >= MODEL_MIN_SIZE) {
        const how = materializeFromCache(cached, dest);
        log(`model ok (${(size / 1e6).toFixed(1)} MB) — cached at ${cached}, ${how}ed to ${dest}`);
        return;
      }
      log(`download incomplete (${size} bytes), trying next mirror`);
    } catch (e) {
      log(`mirror failed: ${e.message}`);
      await sleep(500);
    }
  }
  throw new Error(
    `Unable to download ${MODEL_NAME} from any mirror. ` +
    `Place the file manually at ${cached} or ${dest} (~190 MB).`,
  );
}

function findInstalledBinary(name) {
  // explicit candidates
  const candidates = BREW_CANDIDATES[name] || [];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // PATH
  const onPath = which(name);
  if (onPath) return onPath;
  return null;
}

// Resolve the brew Cellar lib/ for whichever whisper-cpp binary we're staging,
// so @rpath/... references can be turned into absolute paths.
function brewLibDirFor(srcBin) {
  if (!srcBin.includes('/whisper-cpp/')) return null;
  const root = srcBin.replace(/\/bin\/[^/]+$/, '');
  const lib = join(root, 'lib');
  return existsSync(lib) ? lib : null;
}

function copyOneBinary(srcBin, destDir, name) {
  const destBin = join(destDir, name);
  copyFileSync(srcBin, destBin);
  chmodSync(destBin, 0o755);
  log(`copied ${name} → ${destBin}`);

  // Inspect the binary's dylib references; copy any @rpath libs we own.
  const otool = spawnSync('otool', ['-L', srcBin], { encoding: 'utf8' });
  if (otool.status !== 0) {
    log(`otool unavailable for ${name}; binary copied as-is (system libs only assumed)`);
    return;
  }
  const lines = otool.stdout.split('\n').slice(1);
  const ourLibs = lines
    .map((l) => l.trim().split(' ')[0])
    .filter((p) => p && (p.startsWith('@rpath/') || p.startsWith('/opt/homebrew/') || p.startsWith('/usr/local/')));

  const brewLib = brewLibDirFor(srcBin);

  for (const ref of ourLibs) {
    let abs = ref;
    if (ref.startsWith('@rpath/')) {
      if (!brewLib) continue;
      abs = join(brewLib, ref.slice('@rpath/'.length));
    }
    if (!existsSync(abs)) continue;
    const libName = abs.split('/').pop();
    const out = join(destDir, libName);
    copyFileSync(abs, out);
    chmodSync(out, 0o644);
    log(`refreshed dep ${libName}`);

    // Recursively copy that dylib's deps too (one level deep is usually enough).
    const sub = spawnSync('otool', ['-L', abs], { encoding: 'utf8' });
    if (sub.status === 0) {
      for (const l of sub.stdout.split('\n').slice(1)) {
        const p = l.trim().split(' ')[0];
        if (!p) continue;
        let pAbs = p;
        if (p.startsWith('@rpath/') && brewLib) pAbs = join(brewLib, p.slice('@rpath/'.length));
        if (existsSync(pAbs) && (p.startsWith('@rpath/') || p.startsWith('/opt/homebrew/'))) {
          const pn = pAbs.split('/').pop();
          const outP = join(destDir, pn);
          copyFileSync(pAbs, outP);
          chmodSync(outP, 0o644);
          log(`refreshed transitive dep ${pn}`);
        }
      }
    }
  }
}

// Copy ggml backend .so files (BLAS, Metal, per-CPU-arch) into destDir.
// Idempotent: skips files already present.
function copyGgmlBackends(destDir) {
  const ggmlLibexec = (() => {
    const r = spawnSync('sh', ['-c', 'ls -d /opt/homebrew/Cellar/ggml/*/libexec 2>/dev/null | head -1'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  })();
  if (ggmlLibexec && existsSync(ggmlLibexec)) {
    for (const so of readdirSync(ggmlLibexec)) {
      if (!so.endsWith('.so')) continue;
      const src = join(ggmlLibexec, so);
      const dst = join(destDir, so);
      copyFileSync(src, dst);
      chmodSync(dst, 0o755);
      log(`refreshed backend ${so}`);
    }
  } else {
    log('warn: ggml libexec dir not found; backends will not be bundled');
  }
}

// Rewrite @rpath/absolute brew paths inside every binary/dylib/so in destDir
// to @loader_path so they resolve against the colocated files at runtime.
// Then ad-hoc re-sign — install_name_tool invalidates the existing signature
// and macOS Gatekeeper SIGKILLs unsigned mach-o on exec.
function relinkAndSign(destDir, binaryNames) {
  const allBins = readdirSync(destDir).filter(
    (f) => binaryNames.includes(f) || f.endsWith('.dylib') || f.endsWith('.so'),
  );
  for (const f of allBins) {
    const fp = join(destDir, f);
    const ins = spawnSync('otool', ['-L', fp], { encoding: 'utf8' });
    if (ins.status !== 0) continue;
    for (const l of ins.stdout.split('\n').slice(1)) {
      const ref = l.trim().split(' ')[0];
      if (!ref) continue;
      if (ref.startsWith('@rpath/')) {
        const newRef = `@loader_path/${ref.slice('@rpath/'.length)}`;
        spawnSync('install_name_tool', ['-change', ref, newRef, fp]);
      } else if (ref.startsWith('/opt/homebrew/') || ref.startsWith('/usr/local/')) {
        const libName = ref.split('/').pop();
        if (existsSync(join(destDir, libName))) {
          spawnSync('install_name_tool', ['-change', ref, `@loader_path/${libName}`, fp]);
        }
      }
    }
    if (f.endsWith('.dylib') || f.endsWith('.so')) {
      spawnSync('install_name_tool', ['-id', `@loader_path/${f}`, fp]);
    }
  }
  log('dylib paths rewritten to @loader_path');

  for (const f of allBins) {
    const fp = join(destDir, f);
    const r = spawnSync('codesign', ['--force', '--sign', '-', fp]);
    if (r.status !== 0) log(`warn: codesign failed for ${f}`);
  }
  log('ad-hoc re-signed after relocation');
}

async function ensureBinary() {
  const targets = ['whisper-cli', 'whisper-server'];
  const copied = [];
  let anyCopied = false;

  // Cross-platform: ONE official v1.9.1 archive bundles both binaries +
  // ggml libs (verified asset names in scripts/lib/whisper-platforms.mjs).
  if (platform !== 'darwin') {
    const cliBin = join(outDir, whisperBinaryName('whisper-cli', platform));
    if (existsSync(cliBin)) {
      log('whisper binaries already present — skip');
      return;
    }
    const url = whisperArchiveFor(platform, arch);
    if (!url) {
      // Only win32-arm64 reaches here (no official prebuilt). linux-arm64
      // has an official ubuntu archive since v1.9.1 — see whisper-platforms.mjs.
      throw new Error(
        `No official whisper.cpp prebuilt for ${platform}-${arch}. ` +
        'Build from source first (cmake) so build/whisper/ contains ' +
        'whisper-cli + ggml libs.',
      );
    }
    const ext = url.endsWith('.zip') ? '.zip' : '.tar.gz';
    const archive = join(outDir, `whisper-bin${ext}`);
    log(`downloading official prebuilt archive from ${url}`);
    await downloadWithCurl(url, archive);
    log(`extracting ${archive}`);
    if (ext === '.zip') {
      if (platform === 'win32') {
        const r = spawnSync('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -Force -Path '${archive}' -DestinationPath '${outDir}'`],
          { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`Expand-Archive failed: ${r.stderr}`);
      } else {
        const r = spawnSync('unzip', ['-o', archive, '-d', outDir], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`unzip failed: ${r.stderr}`);
      }
    } else {
      const r = spawnSync('tar', ['-xzf', archive, '-C', outDir], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`);
    }
    try { unlinkSync(archive); } catch { /* ignore */ }
    for (const name of targets) {
      const bin = join(outDir, whisperBinaryName(name, platform));
      if (existsSync(bin)) chmodSync(bin, 0o755);
    }
    if (!existsSync(cliBin)) {
      throw new Error(`whisper-cli missing after extracting ${url}`);
    }
    log('official prebuilt binaries extracted');
    return;
  }

  // macOS: use Homebrew or build from source
  for (const name of targets) {
    const destBin = join(outDir, name);
    const src = findInstalledBinary(name);
    if (!src) {
      if (name === 'whisper-server') {
        // Not fatal: server mode is an optimization. The app falls back to
        // per-call whisper-cli, which is also bundled.
        log('warn: whisper-server not found — server mode will be disabled, falling back to per-call whisper-cli');
        continue;
      }
      // whisper-cli is mandatory; print the manual-install banner and bail.
      log('');
      log('whisper-cli not found. Install one of:');
      log('  1) brew install whisper-cpp        (recommended; this script will copy it on next run)');
      log('  2) Build from source: https://github.com/ggml-org/whisper.cpp');
      log('');
      log(`Then re-run: node scripts/fetch-whisper.mjs`);
      log('The app will fall back to webkitSpeechRecognition until whisper-cli is available.');
      // Exit 0 — missing binary should NOT fail the wider build pipeline during
      // development. Packaging will check separately.
      return;
    }
    log(`found system ${name} at ${src}`);
    copyOneBinary(src, outDir, name);
    copied.push(name);
    anyCopied = true;
  }

  // Refresh the entire native closure on every macOS build. Skipping existing
  // files can combine a newly upgraded whisper binary with stale ggml dylibs,
  // an ABI mismatch that tends to appear only on machines without Homebrew.
  copyGgmlBackends(outDir);
  relinkAndSign(outDir, copied);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  // Fatal on failure (Phase 6b): a package without whisper assets must fail
  // HERE, not ship silently — CI additionally gates with
  // scripts/assert-whisper-assets.mjs.
  await ensureModel();
  await ensureBinary();
  log('done');
}

main().catch((e) => {
  process.stderr.write(`[fetch-whisper] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
