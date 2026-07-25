// approval-gesture.ts — maps a pending tool call onto the AhaBar / virtual-
// keyboard approve gesture. This sits ON TOP of ToolRisk / AutoApproveScope:
// auto-approve still decides whether a call becomes pending at all; once it
// is pending, this module decides how hard the user has to press Key2.
//
//   low  → single click allow
//   mid  → hold 800ms then allow
//   high → no shortcut allow; jump to the meeting PermissionCard

import { classifyToolRisk } from './auto-approve-policy.js';

export type ApprovalGesture = 'low' | 'mid' | 'high';

const HIGH_BASH_RE = /\b(rm\s+(-[a-zA-Z]*f[a-zA-Z]*|--force)|sudo\b|mkfs\b|dd\s+if=|>\s*\/dev\/|shutdown\b|reboot\b)\b/i;

const ALWAYS_HIGH_PREFIXES: ReadonlyArray<string> = [
  'mcp__embedded-browser__browser_evaluate',
];

/** Short path / command excerpt for the AhaBar hover card. Never the full
 *  payload — that stays in the meeting PermissionCard. */
export function summarizeApprovalTarget(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const pathLike = [input.file_path, input.path, input.target_directory]
    .find((v) => typeof v === 'string' && (v as string).trim()) as string | undefined;
  if (pathLike) {
    const parts = pathLike.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? pathLike;
  }
  if (typeof input.command === 'string' && input.command.trim()) {
    const cmd = input.command.replace(/\s+/g, ' ').trim();
    return cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd;
  }
  return toolName;
}

export function classifyApprovalGesture(
  toolName: string,
  input: Record<string, unknown> = {},
): ApprovalGesture {
  for (const prefix of ALWAYS_HIGH_PREFIXES) {
    if (toolName === prefix || toolName.startsWith(`${prefix}_`)) return 'high';
  }
  if (toolName === 'Bash' || toolName === 'Shell') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (HIGH_BASH_RE.test(command)) return 'high';
    return 'mid';
  }
  if (classifyToolRisk(toolName) === 'safe') return 'low';
  return 'mid';
}

const RISK_RANK: Record<ApprovalGesture, number> = { high: 3, mid: 2, low: 1 };

/** Highest-priority pending approval wins the virtual keyboard target. */
export function compareApprovalPriority(
  a: { risk: ApprovalGesture; arrivedAt: number },
  b: { risk: ApprovalGesture; arrivedAt: number },
): number {
  const riskDiff = RISK_RANK[b.risk] - RISK_RANK[a.risk];
  if (riskDiff !== 0) return riskDiff;
  return a.arrivedAt - b.arrivedAt;
}
