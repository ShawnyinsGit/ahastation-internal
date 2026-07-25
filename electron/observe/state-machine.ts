// state-machine.ts — three-signal state inference (plan §4.1.5).
//
// No mtime-based activity inference: Claude Code writes assistant turns
// atomically, so a long streaming reply keeps the file mtime frozen and an
// mtime threshold would flicker (abtop lesson). State comes from:
//   Claude: descendant CPU > 5%  ‖  unclosed trailing tool_use  → Executing
//           trailing real user without later assistant          → Thinking
//           otherwise                                           → Waiting
//   Codex:  (exec && task_complete) ‖ (unclaimed && mtime<5min) → Done
//           active child CPU>5% ‖ pending function_call         → Executing
//           generating                                          → Thinking
//           otherwise                                           → Waiting
//   Kimi:   dead pid                                            → drop (null)
//           descendant CPU > 5%                                 → Executing
//           trailing llm request without llm response           → Thinking
//           otherwise                                           → Waiting
//
// Disappearance asymmetry: a Claude session whose associated pid died
// vanishes (null); Kimi follows the same rule. A Codex session without a
// live owner stays visible as Done inside the completion window; outside
// the window it degrades to Idle (kept as file-only evidence) rather than
// vanishing, so the layer still reports recently active sessions on
// machines where nothing is currently running.

import type {
  ClaudeTailSignals,
  CodexTailSignals,
  KimiTailSignals,
  ObservedActivity,
  ObservedState,
} from './types.js';

export const CPU_EXECUTING_THRESHOLD = 5;
export const CODEX_DONE_WINDOW_MS = 5 * 60 * 1000;

export type PidState = 'live' | 'dead' | 'none';

export interface InferredState {
  state: ObservedState;
  activity: ObservedActivity;
}

export interface ClaudeStateInput {
  tail: ClaudeTailSignals;
  descendantCpuMax: number;
  pidState: PidState;
}

/** null = drop the session (Claude has no completion window). */
export function inferClaudeState(input: ClaudeStateInput): InferredState | null {
  if (input.pidState === 'dead') return null;
  if (input.pidState === 'none') {
    // File-only evidence: no live process claims the transcript, so tail
    // signals are stale history, not current activity.
    return { state: 'unknown', activity: 'unknown' };
  }
  if (input.descendantCpuMax > CPU_EXECUTING_THRESHOLD || input.tail.unclosedToolUse) {
    return { state: 'active', activity: 'executing' };
  }
  if (input.tail.trailingRealUser) {
    return { state: 'active', activity: 'thinking' };
  }
  return { state: 'waiting', activity: 'waiting' };
}

export interface CodexStateInput {
  tail: CodexTailSignals;
  descendantCpuMax: number;
  pidState: PidState;
  mtimeMs: number;
  now: number;
  doneWindowMs?: number;
}

export function inferCodexState(input: CodexStateInput): InferredState {
  const doneWindowMs = input.doneWindowMs ?? CODEX_DONE_WINDOW_MS;
  // task_complete only ends one-shot `codex exec` sessions; interactive
  // sessions emit it every turn.
  if (input.tail.isExec && input.tail.sawTaskComplete) {
    return { state: 'done', activity: 'unknown' };
  }
  if (input.pidState !== 'live') {
    if (input.now - input.mtimeMs < doneWindowMs) {
      return { state: 'done', activity: 'unknown' };
    }
    return { state: 'idle', activity: 'unknown' };
  }
  if (input.descendantCpuMax > CPU_EXECUTING_THRESHOLD || input.tail.pendingFunctionCalls > 0) {
    return { state: 'active', activity: 'executing' };
  }
  if (input.tail.generating) {
    return { state: 'active', activity: 'thinking' };
  }
  return { state: 'waiting', activity: 'waiting' };
}

export interface KimiStateInput {
  tail: KimiTailSignals;
  descendantCpuMax: number;
  pidState: PidState;
}

/** null = drop the session (like Claude, Kimi has no completion window).
 * Executing signals (hot child process) win over the in-flight request,
 * mirroring the Claude ordering. */
export function inferKimiState(input: KimiStateInput): InferredState | null {
  if (input.pidState === 'dead') return null;
  if (input.pidState === 'none') {
    // File-only evidence: the log tail is stale history, not live activity.
    return { state: 'unknown', activity: 'unknown' };
  }
  if (input.descendantCpuMax > CPU_EXECUTING_THRESHOLD) {
    return { state: 'active', activity: 'executing' };
  }
  if (input.tail.inFlightRequest) {
    return { state: 'active', activity: 'thinking' };
  }
  return { state: 'waiting', activity: 'waiting' };
}
