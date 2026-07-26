// terminal-backends.ts — renderer mirror of
// electron/backends/terminal-cli-adapter.ts TERMINAL_WORKER_BACKEND_IDS.
// Keep the two lists in sync: these are the backends that run a
// human-supervised interactive TUI worker inside a pty (stage terminal).

export const TERMINAL_WORKER_BACKEND_IDS: readonly string[] = [
  'claude-code-terminal',
  'kimi-code-terminal',
  'codex-terminal',
  'qoder-terminal',
];

const TERMINAL_WORKER_BACKEND_ID_SET: ReadonlySet<string> = new Set(TERMINAL_WORKER_BACKEND_IDS);

export function isTerminalWorkerBackendId(backendId: string | null | undefined): boolean {
  return !!backendId && TERMINAL_WORKER_BACKEND_ID_SET.has(backendId);
}
