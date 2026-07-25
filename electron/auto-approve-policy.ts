// auto-approve-policy.ts — risk classification for tool calls under auto-approve.
//
// Auto-approve was originally a single boolean: when on, every canUseTool call
// short-circuits to allow. That's fine for Read/Grep but dangerous for Write/
// Bash — a renderer compromise (XSS, injected script) could flip the toggle
// or fake the in-renderer approval row and run anything. This module narrows
// auto-approve to demonstrably-safe tools; destructive ones still escalate to
// a user prompt (in Electron, a native OS dialog from main, which a
// compromised renderer cannot fake) even when auto-approve is on.

export type ToolRisk = 'safe' | 'destructive';

/**
 * Auto-approve scope — controls which tools are silently approved.
 *   'off'  → no auto-approve, all tools go through the permission flow
 *   'read' → only read-only / safe tools are auto-approved
 *   'all'  → all tools (including Write/Bash) are auto-approved without prompt
 */
export type AutoApproveScope = 'off' | 'read' | 'all';

// Tools that only READ state — auto-approve is allowed to short-circuit these.
// `Task` delegates to a subagent which runs with its own canUseTool gate, so
// the delegation itself is harmless (the subagent's individual tool calls are
// independently classified by this same module). `TodoWrite` writes only to
// the SDK's own per-session todo store, not the user's filesystem.
const SAFE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'NotebookRead',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'ListMcpResources',
  'ReadMcpResource',
  'ExitPlanMode',
  'BashOutput',
]);

// MCP tools we host in-proc (meeting orchestration). They drive UI/orchestrator
// state, never the user's filesystem, so they are always safe to auto-approve.
const SAFE_MCP_PREFIXES: ReadonlyArray<string> = [
  'mcp__meeting__',
  'mcp__meeting-worker__',
];

// Meeting-MCP tools that reach OUTSIDE the app — focusing another app's
// window or typing into another process's terminal. They must ALWAYS surface
// as approval requests (permission card / native confirm), never auto-allow,
// regardless of scope. The carve-out sits ahead of the mcp__meeting__ prefix.
const NEVER_SAFE_MCP_TOOLS: ReadonlySet<string> = new Set([
  'mcp__meeting__observed_session_focus',
  'mcp__meeting__observed_session_send_text',
]);

// Computer Use MCP tools with individual risk classification. screenshot,
// mouse_move, and scroll are read-only / low-risk; click and keyboard actions
// are destructive (they modify external application state).
const SAFE_COMPUTER_USE_TOOLS: ReadonlySet<string> = new Set([
  'mcp__embedded-browser__browser_navigate',
  'mcp__embedded-browser__browser_snapshot',
  'mcp__embedded-browser__browser_console_messages',
  'mcp__embedded-browser__browser_close',
  'mcp__embedded-browser__browser_tab_list',
  'mcp__embedded-browser__browser_tab_select',
  'mcp__embedded-browser__browser_tab_new',
  'mcp__embedded-browser__browser_tab_close',
  'mcp__computer-use__screenshot',
  'mcp__computer-use__mouse_move',
  'mcp__computer-use__scroll',
]);

// Embedded browser tools that execute arbitrary JavaScript in a web context.
// These are always destructive — even under 'all' auto-approve, they must go
// through the native OS confirmation dialog. An AI worker (or prompt injection)
// could exfiltrate cookies/session tokens from authenticated web sessions.
const ALWAYS_DESTRUCTIVE_PREFIXES: ReadonlyArray<string> = [
  'mcp__embedded-browser__browser_evaluate',
];

export function classifyToolRisk(toolName: string): ToolRisk {
  // Always-destructive tools bypass auto-approve entirely, even at 'all' scope.
  for (const prefix of ALWAYS_DESTRUCTIVE_PREFIXES) {
    if (toolName === prefix || toolName.startsWith(prefix + '_')) return 'destructive';
  }
  // Observed-session actions: external side effects on other apps' windows —
  // approval-gated in every scope (checked before the meeting safe prefix).
  if (NEVER_SAFE_MCP_TOOLS.has(toolName)) return 'destructive';
  if (SAFE_BUILTIN_TOOLS.has(toolName)) return 'safe';
  if (SAFE_COMPUTER_USE_TOOLS.has(toolName)) return 'safe';
  for (const prefix of SAFE_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return 'safe';
  }
  // Fail-safe: unknown tool → destructive. Better to nag the user about a
  // harmless tool than silently auto-allow something we haven't classified.
  return 'destructive';
}

/** In-proc tools that are safe regardless of auto-approve scope: the meeting
 *  MCP servers only drive UI/orchestrator state, and `Task` merely delegates
 *  to a subagent whose individual tool calls are independently gated (same
 *  argument as SAFE_BUILTIN_TOOLS above). Consulted by the task-authority
 *  bridge, where these otherwise classify as 'external' and would raise an
 *  approval card on every meeting-worker report. */
export function isInProcSafeTool(toolName: string): boolean {
  if (NEVER_SAFE_MCP_TOOLS.has(toolName)) return false;
  if (toolName === 'Task') return true;
  return SAFE_MCP_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}
