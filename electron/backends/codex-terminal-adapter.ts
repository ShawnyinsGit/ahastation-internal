// codex-terminal-adapter.ts — interactive `codex` TUI as a Worker backend.
//
// Runs the user's own Codex CLI inside a PtyHost pty (see the generic
// skeleton in terminal-cli-adapter.ts). The Stop hook is injected via
// `-c key=value` inline-TOML overrides on the command line, so the user's
// own ~/.codex/config.toml (auth, project trust, model prefs) stays fully
// intact — no managed CODEX_HOME, no config writes.
//
// Known limitation (docs/research/codex-cli-protocol.md): non-managed
// command hooks must be trusted once in the TUI (`/hooks`) before they fire.
// The terminal worker is human-supervised by design, so this surfaces as a
// one-time prompt the user answers at the stage terminal; the confirm bar
// remains the manual fallback until then.

import type { BackendCapabilities } from './cli-backend.js';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import {
  TerminalCliBackend,
  type TerminalCliBackendDeps,
  type TerminalCliProfile,
} from './terminal-cli-adapter.js';

const CODEX_TERMINAL_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  executeTasks: true,
  displayName: 'Codex (终端)',
  iconId: 'codex',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  defaultModel: 'gpt-5.4',
  models: ['gpt-5.4'],
  installHint: '使用本机已安装的 codex CLI（PATH 上的 codex 命令，npm i -g @openai/codex）',
};

export const CODEX_TERMINAL_PROFILE: TerminalCliProfile = {
  id: 'codex-terminal',
  capabilities: CODEX_TERMINAL_CAPABILITIES,
  displayLabel: 'Codex',
  resolveBinary: () => resolveBinaryFromPath('codex'),
  buildCliArgs: (config) => {
    const args: string[] = [];
    if (config.model) args.push('-m', config.model);
    // Approval tiers (docs/research/codex-cli-protocol.md): default = ask in
    // TUI; 'read' ≈ --full-auto (auto low-risk, still asks for high-risk);
    // 'all' = --dangerously-bypass-approvals-and-sandbox.
    if (config.autoApproveScope === 'read') args.push('--full-auto');
    else if (config.autoApproveScope === 'all') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    return args;
  },
  registerTurnHook: ({ hookCommand }) => {
    // Inline-TOML injection: `codex -c hooks=true -c 'hooks.Stop=[...]'`.
    // The hook command is embedded as a TOML basic string (backslashes and
    // double quotes escaped). No files are created here — the shared hook
    // script and events file are skeleton-managed.
    const tomlCommand = hookCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return {
      cliArgs: [
        '-c', 'hooks=true',
        '-c', `hooks.Stop=[{matcher="",hooks=[{type="command",command="${tomlCommand}",timeout=30}]}]`,
      ],
      cleanupPaths: [],
    };
  },
  startupMessage: '终端 Codex 已启动，任务提示词将自动注入 TUI。若提示信任 hooks，请在终端中确认一次。',
  missingBinaryMessage: '未找到 codex CLI，可执行文件不在 PATH 上。可运行 npm i -g @openai/codex 安装。',
};

export class CodexTerminalBackend extends TerminalCliBackend {
  constructor(deps: TerminalCliBackendDeps = {}) {
    super(CODEX_TERMINAL_PROFILE, deps);
  }
}
