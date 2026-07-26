// kimi-terminal-adapter.ts — interactive `kimi` TUI as a Worker backend.
//
// Runs the user's own Kimi Code CLI inside a PtyHost pty (see the generic
// skeleton in terminal-cli-adapter.ts). Kimi has no `--settings`-style flag,
// so the Stop hook is injected through a managed KIMI_CODE_HOME: a per-session
// data root under <cwd>/.aha with its own config.toml carrying the hook,
// while login state (oauth/credentials/device_id) and workspace trust
// (workspaces.json) are symlinked in from the user's real ~/.kimi-code so the
// TUI starts authenticated and trusted.

import { accessSync, constants as fsConstants, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BackendCapabilities } from './cli-backend.js';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import {
  TerminalCliBackend,
  type TerminalCliBackendDeps,
  type TerminalCliProfile,
} from './terminal-cli-adapter.js';

const KIMI_TERMINAL_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  executeTasks: true,
  displayName: 'Kimi Code (终端)',
  iconId: 'kimi',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  defaultModel: 'kimi-latest',
  models: ['kimi-latest'],
  installHint: process.platform === 'win32'
    ? 'Kimi CLI is not yet available for Windows. Visit https://code.kimi.com for updates.'
    : 'curl -LsSf https://code.kimi.com/install.sh | bash',
};

/** TOML basic string: escape backslashes and double quotes. */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function resolveKimiBinary(): string | null {
  const canonical = join(homedir(), '.kimi-code', 'bin', 'kimi');
  try {
    accessSync(canonical, fsConstants.X_OK);
    return realpathSync(canonical);
  } catch {
    return resolveBinaryFromPath('kimi');
  }
}

export const KIMI_TERMINAL_PROFILE: TerminalCliProfile = {
  id: 'kimi-code-terminal',
  capabilities: KIMI_TERMINAL_CAPABILITIES,
  displayLabel: 'Kimi',
  resolveBinary: resolveKimiBinary,
  buildCliArgs: (config) => {
    const args: string[] = [];
    if (config.model) args.push('-m', config.model);
    // Approval tiers (docs/research/kimi-cli-protocol.md): default = ask in
    // TUI; 'read' ≈ -y (auto-approve routine tool calls, may still ask);
    // 'all' = --auto (fully automatic, never asks).
    if (config.autoApproveScope === 'read') args.push('-y');
    else if (config.autoApproveScope === 'all') args.push('--auto');
    return args;
  },
  registerTurnHook: ({ ahaDir, suffix, hookCommand }) => {
    const homeDir = join(ahaDir, `kimi-home-${suffix}`);
    mkdirSync(homeDir, { recursive: true });
    // Carry over login state and workspace trust from the user's real data
    // root. Best-effort per entry: a fresh install may not have all of them.
    const realHome = join(homedir(), '.kimi-code');
    for (const name of ['oauth', 'credentials', 'device_id', 'workspaces.json', 'tui.toml']) {
      try {
        symlinkSync(join(realHome, name), join(homeDir, name));
      } catch { /* source missing or link exists — the TUI handles both */ }
    }
    writeFileSync(join(homeDir, 'config.toml'), [
      '# AhaStation terminal-worker managed KIMI_CODE_HOME (auto-generated, safe to delete)',
      '[[hooks]]',
      'event = "Stop"',
      'matcher = ""',
      `command = ${tomlBasicString(hookCommand)}`,
      'timeout = 30',
      '',
    ].join('\n'));
    return {
      cliArgs: [],
      env: { KIMI_CODE_HOME: homeDir },
      cleanupPaths: [homeDir],
    };
  },
  startupMessage: '终端 Kimi 已启动，任务提示词将自动注入 TUI。',
  missingBinaryMessage: '未找到 kimi CLI，可执行文件不在 PATH 上，也没有 ~/.kimi-code/bin/kimi。可运行 curl -LsSf https://code.kimi.com/install.sh | bash 安装。',
};

export class KimiTerminalBackend extends TerminalCliBackend {
  constructor(deps: TerminalCliBackendDeps = {}) {
    super(KIMI_TERMINAL_PROFILE, deps);
  }
}
