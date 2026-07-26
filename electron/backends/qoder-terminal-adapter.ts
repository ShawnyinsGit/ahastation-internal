// qoder-terminal-adapter.ts — interactive `qodercli` TUI as a Worker backend.
//
// Runs the user's own Qoder CLI inside a PtyHost pty (see the generic
// skeleton in terminal-cli-adapter.ts). Qoder has no hooks mechanism and
// `qodercli jobs` only tracks --worktree jobs (verified against
// qodercli 0.1.50-qw: interactive TUI sessions never appear there), so this
// backend registers NO Stop hook — the renderer confirm bar is the turn-end
// signal, which is the designed human fallback for every terminal backend.

import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import type { BackendCapabilities } from './cli-backend.js';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import {
  TerminalCliBackend,
  type TerminalCliBackendDeps,
  type TerminalCliProfile,
} from './terminal-cli-adapter.js';

const QODER_BUNDLED_BINARY =
  '/Applications/QoderWork.app/Contents/Resources/bin/qodercli';

const QODER_TERMINAL_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  executeTasks: true,
  displayName: 'Qoder (终端)',
  iconId: 'qoder',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  defaultModel: 'auto',
  models: ['auto', 'efficient', 'lite', 'performance', 'ultimate'],
  installHint: '安装 QoderWork 桌面端（自带 qodercli），或将 qodercli 加入 PATH。',
};

/** Read-only tool allowlist for the 'read' approval tier. Tool names follow
 *  the Claude-compatible convention Qoder advertises; an unrecognized name
 *  simply means the TUI keeps asking, which is the safe direction. */
const QODER_READ_ONLY_TOOLS = 'Read,Grep,Glob,LS,WebFetch,WebSearch,TodoWrite';

export function resolveQoderBinary(): string | null {
  const fromPath = resolveBinaryFromPath('qodercli');
  if (fromPath) return fromPath;
  try {
    accessSync(QODER_BUNDLED_BINARY, fsConstants.X_OK);
    return realpathSync(QODER_BUNDLED_BINARY);
  } catch {
    return null;
  }
}

export const QODER_TERMINAL_PROFILE: TerminalCliProfile = {
  id: 'qoder-terminal',
  capabilities: QODER_TERMINAL_CAPABILITIES,
  displayLabel: 'Qoder',
  resolveBinary: resolveQoderBinary,
  buildCliArgs: (config) => {
    const args: string[] = ['-w', config.cwd];
    if (config.model) args.push('--model', config.model);
    // Approval tiers (docs/research/qoder-cli-protocol.md): default = ask in
    // TUI; 'read' = read-only tool allowlist; 'all' = --yolo (skip all
    // permission checks).
    if (config.autoApproveScope === 'read') {
      args.push('--allowed-tools', QODER_READ_ONLY_TOOLS);
    } else if (config.autoApproveScope === 'all') {
      args.push('--yolo');
    }
    return args;
  },
  // No registerTurnHook: Qoder has no hooks; the confirm bar is the signal.
  startupMessage: '终端 Qoder 已启动，任务提示词将自动注入 TUI。每轮结束后请在上方确认条人工确认。',
  missingBinaryMessage: '未找到 qodercli，可执行文件不在 PATH 上，也没有 QoderWork.app 内置版本。',
};

export class QoderTerminalBackend extends TerminalCliBackend {
  constructor(deps: TerminalCliBackendDeps = {}) {
    super(QODER_TERMINAL_PROFILE, deps);
  }
}
