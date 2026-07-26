// claude-terminal-adapter.ts — interactive `claude` TUI as a Worker backend.
//
// Unlike claude-code-adapter (headless SDK), this backend runs the user's own
// interactive Claude Code CLI inside a PtyHost pty. All session mechanics
// (bracketed-paste injection, Stop-hook tailing, ready gating) live in the
// generic skeleton terminal-cli-adapter.ts; this file only carries the
// Claude-specific profile: binary resolution, --settings hook registration,
// model flag and ANTHROPIC_* auth mapping.
//
// The protocol marker constants are re-exported from the skeleton so existing
// imports (worker-scheduler, renderer mirror, tests) keep working.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveClaudeBinaryForSource } from '../claude-cli/resolve.js';
import type { BackendSessionConfig, BackendCapabilities } from './cli-backend.js';
import {
  TerminalCliBackend,
  type TerminalCliBackendDeps,
  type TerminalCliProfile,
} from './terminal-cli-adapter.js';

// ── Re-exports (stable import path for scheduler / renderer / tests) ────────

export {
  TERMINAL_TURN_ENDED_MARKER,
  TERMINAL_TURN_ENDED_MESSAGE,
  TERMINAL_TASK_COMPLETE_MARKER,
  TERMINAL_TASK_COMPLETE_MESSAGE,
  TERMINAL_WORKER_COMPLETION_INSTRUCTION,
  buildPasteFrame,
  parseTurnEventLines,
} from './terminal-cli-adapter.js';

// ── Claude profile ───────────────────────────────────────────────────────────

const CLAUDE_TERMINAL_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  executeTasks: true,
  displayName: 'Claude Code (终端)',
  iconId: 'claude',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  defaultModel: 'claude-sonnet-4-20250514',
  models: [
    'claude-sonnet-4-20250514',
    'claude-haiku-4-5-20251001',
    'claude-opus-4-20250514',
  ],
  installHint: '使用本机已安装的 claude CLI（PATH 上的 claude 命令）',
};

export const CLAUDE_TERMINAL_PROFILE: TerminalCliProfile = {
  id: 'claude-code-terminal',
  capabilities: CLAUDE_TERMINAL_CAPABILITIES,
  displayLabel: 'Claude',
  resolveBinary: () => resolveClaudeBinaryForSource(),
  buildCliArgs: (config: BackendSessionConfig) =>
    config.model ? ['--model', config.model] : [],
  registerTurnHook: ({ suffix, ahaDir, hookCommand }) => {
    // Claude Code accepts a per-session --settings file; the Stop hook lives
    // there so the user's own settings are never touched.
    const settingsPath = join(ahaDir, `terminal-claude-settings-${suffix}.json`);
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: hookCommand, timeout: 30 }] }],
      },
    }, null, 2));
    return {
      cliArgs: ['--settings', settingsPath],
      cleanupPaths: [settingsPath],
    };
  },
  startupMessage: '终端 Claude 已启动，任务提示词将自动注入 TUI。',
  missingBinaryMessage: '未找到 claude CLI，可执行文件不在 PATH 上，也没有可用的内置回退。',
  applyAuth: (env, auth) => {
    if (auth.apiKey) env.ANTHROPIC_API_KEY = auth.apiKey;
    if (auth.baseUrl) env.ANTHROPIC_BASE_URL = auth.baseUrl;
    if (auth.model) env.ANTHROPIC_MODEL = auth.model;
  },
};

export class ClaudeTerminalBackend extends TerminalCliBackend {
  constructor(deps: TerminalCliBackendDeps = {}) {
    super(CLAUDE_TERMINAL_PROFILE, deps);
  }
}
