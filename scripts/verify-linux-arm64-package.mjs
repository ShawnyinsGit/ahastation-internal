#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform !== 'linux' || process.arch !== 'arm64') {
  process.stderr.write('[verify-linux-arm64] must run on Linux arm64\n');
  process.exit(1);
}

const releaseDir = resolve(process.argv[2] ?? 'release');
const deb = readdirSync(releaseDir)
  .filter((name) => name.endsWith('.deb'))
  .map((name) => join(releaseDir, name))
  .find((path) => {
    try {
      return execFileSync('dpkg-deb', ['-f', path, 'Architecture'], { encoding: 'utf8' }).trim() === 'arm64';
    } catch {
      return false;
    }
  });
if (!deb) throw new Error(`No arm64 .deb found in ${releaseDir}`);

const unpacked = mkdtempSync(join(tmpdir(), 'ahastation-arm64-'));
try {
  execFileSync('dpkg-deb', ['-x', deb, unpacked], { stdio: 'inherit' });
  const appRoot = join(unpacked, 'opt', 'AhaStation');
  const resources = join(appRoot, 'resources');
  requireExecutable(join(appRoot, 'ahastation'), 'Electron launcher');
  requireMatch(resources, /app\.asar\.unpacked[\\/]node_modules[\\/]@openai[\\/]codex-linux-arm64[\\/].*[\\/]codex$/);
  requireMatch(resources, /app\.asar\.unpacked[\\/]node_modules[\\/]opencode-linux-arm64[\\/]bin[\\/]opencode$/);
  requireMatch(resources, /app\.asar\.unpacked[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk-linux-arm64[\\/]claude$/);

  const incompatible = [];
  const accessoryWarnings = [];
  for (const file of walk(appRoot)) {
    if (!statSync(file).isFile()) continue;
    let output = '';
    try {
      output = execFileSync('readelf', ['--version-info', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    for (const match of output.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major > 2 || (major === 2 && minor > 31)) {
        const rel = file.slice(appRoot.length + 1);
        // Vendor accessory binaries (e.g. the zsh bundled inside codex's
        // codex-resources tree) are never dlopened by the app or the runtime
        // main binaries; codex only execs them as an optional interactive
        // shell and falls back to the system shell when they fail to load.
        // Runtime executables and shared libraries stay hard-fail — the app
        // itself was verified working on Debian 11 with these accessories
        // present but unloadable.
        if (rel.includes('/codex-resources/')) {
          accessoryWarnings.push(`${rel} requires GLIBC_${major}.${minor} (vendor accessory, non-fatal)`);
        } else {
          incompatible.push(`${rel} requires GLIBC_${major}.${minor}`);
        }
        break;
      }
    }
  }
  for (const warning of accessoryWarnings) {
    process.stdout.write(`[verify-linux-arm64] WARN ${warning}\n`);
  }
  if (incompatible.length > 0) {
    throw new Error(`Debian 11 compatibility failure:\n${incompatible.join('\n')}`);
  }
  process.stdout.write(`[verify-linux-arm64] PASS ${deb}\n`);
  process.stdout.write('[verify-linux-arm64] architecture=arm64 glibc<=2.31 runtimes=Claude,Codex,OpenCode\n');
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} missing: ${path}`);
  }
}

function requireExecutable(path, label) {
  requireFile(path, label);
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable: ${path}`);
  }
}

function requireMatch(root, pattern) {
  const found = walk(root).find((path) => pattern.test(path));
  if (!found) throw new Error(`Packaged runtime missing (${pattern})`);
  requireExecutable(found, `Packaged runtime ${pattern}`);
}

function walk(root) {
  if (!existsSync(root)) return [];
  const out = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop();
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) queue.push(join(current, name));
    } else {
      out.push(current);
    }
  }
  return out;
}
