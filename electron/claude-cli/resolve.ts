// resolve.ts — locate Claude Code CLI binaries.
//
// Default path is the user's own `claude` on PATH (~/.claude login state).
// Settings may pin the app-bundled SDK binary instead (strict 2.1.150 gate).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { getSettings } from '../store.js';

export type ClaudeCodeCliSource = 'bundled' | 'system';

function unpackify(p: string): string {
  return p.replace(/[\\/]app\.asar[\\/]/, (_, sep) => `${sep}app.asar.unpacked${sep}`);
}

/** App-shipped Claude Code binary from @anthropic-ai/claude-agent-sdk-* . */
export function resolveClaudeBundledBinary(): string | null {
  const platform = process.platform;
  const arch = process.arch === 'x64' ? `${platform}-x64` : `${platform}-arm64`;
  const executableName = platform === 'win32' ? 'claude.exe' : 'claude';
  const subpkg = `@anthropic-ai/claude-agent-sdk-${arch}/${executableName}`;
  const packageName = `@anthropic-ai/claude-agent-sdk-${arch}`;
  const require_ = createRequire(import.meta.url);

  try {
    const packageJson = require_.resolve(`${packageName}/package.json`);
    const p = unpackify(join(dirname(packageJson), executableName));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  try {
    const sdkPkg = require_.resolve('@anthropic-ai/claude-agent-sdk/package.json');
    const sdkRequire = createRequire(sdkPkg);
    const p = unpackify(sdkRequire.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  try {
    const p = unpackify(require_.resolve(subpkg));
    if (existsSync(p)) return p;
  } catch { /* fall through */ }

  const guesses = [
    process.resourcesPath && join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'node_modules',
      subpkg,
    ),
    process.resourcesPath && join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      subpkg,
    ),
  ].filter((x): x is string => !!x);
  for (const g of guesses) {
    if (existsSync(g)) return g;
  }
  return null;
}

export function getClaudeCodeCliSource(): ClaudeCodeCliSource {
  return getSettings().claudeCodeCliSource === 'bundled' ? 'bundled' : 'system';
}

export function resolveClaudeBinaryForSource(
  source: ClaudeCodeCliSource = getClaudeCodeCliSource(),
): string | null {
  if (source === 'bundled') {
    return resolveClaudeBundledBinary() ?? resolveClaudeCliBinary();
  }
  return resolveClaudeCliBinary() ?? resolveClaudeBundledBinary();
}

export function resolveClaudeCliBinary(): string | null {
  const fromPath = resolveFromPath();
  if (fromPath) return fromPath;
  const home = homedir();
  const guesses = process.platform === 'win32'
    ? [join(home, '.local', 'bin', 'claude.exe'), join(home, '.local', 'bin', 'claude.cmd')]
    : [join(home, '.local', 'bin', 'claude'), '/usr/local/bin/claude'];
  for (const guess of guesses) {
    if (existsSync(guess)) return guess;
  }
  return null;
}

function resolveFromPath(): string | null {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const output = execFileSync(probe, ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_000,
      windowsHide: true,
    });
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    if (process.platform === 'win32') {
      const picked = lines.find((l) => /\.exe$/i.test(l))
        ?? lines.find((l) => /\.(cmd|bat)$/i.test(l))
        ?? lines[0];
      // npm publishes `claude`, `claude.cmd`, and sometimes `claude.ps1`; `where`
      // lists the extensionless shell script first, which Node cannot exec directly.
      if (picked && !/\.(exe|cmd|bat)$/i.test(picked)) {
        const cmd = `${picked}.cmd`;
        if (existsSync(cmd)) return cmd;
      }
      return picked;
    }
    return lines[0];
  } catch {
    return null;
  }
}

/** Native binaries spawn directly; npm .cmd/.bat shims are not spawnable by
 *  ConPTY/CreateProcess and must go through cmd.exe. */
export function spawnTargetFor(binary: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', binary, ...args] };
  }
  return { file: binary, args };
}
