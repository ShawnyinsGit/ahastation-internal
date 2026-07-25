// board-visibility.ts — main-process mirror of the task board's observed-row
// visibility rule (renderer: src/components/TasksView.tsx columnForObserved —
// the two tsconfigs don't share sources, so the rule is ported here, not
// imported). Used by the companion feed to pick the sessions worth surfacing
// on the AhaBar; keep the two sides in sync when the rule changes.
//
// Rule: `waiting` and `active` always show; `idle` shows only when backed by
// a live process (pid set); `done` shows only while recent; `unknown`
// (file-only, no process) never shows. Noise rows are excluded outright —
// the board buckets them under a collapsed toggle, the bar has no room.

import type { ObservedSession } from './types.js';

/** A done session leaves the surface once it falls outside this window —
 *  same 30-minute horizon as the board's RECENTLY_DONE_WINDOW_MS. */
export const OBSERVED_DONE_WINDOW_MS = 30 * 60_000;

/** Whether an observed session should surface on action-oriented UI. */
export function isBoardableObserved(session: ObservedSession, now: number): boolean {
  if (session.isNoise) return false;
  switch (session.state) {
    case 'waiting':
    case 'active':
      return true;
    case 'idle':
      return session.pid !== undefined;
    case 'done':
      return now - session.lastActiveAt <= OBSERVED_DONE_WINDOW_MS;
    default:
      return false;
  }
}

/** Waiting (needs attention) first, then most-recently-active first. */
export function compareBoardableObserved(a: ObservedSession, b: ObservedSession): number {
  const aWaiting = a.state === 'waiting' ? 0 : 1;
  const bWaiting = b.state === 'waiting' ? 0 : 1;
  if (aWaiting !== bWaiting) return aWaiting - bWaiting;
  return b.lastActiveAt - a.lastActiveAt;
}

/** Visible observed sessions, sorted for display. Returns a new array. */
export function boardableObservedSessions(
  sessions: ObservedSession[],
  now: number,
): ObservedSession[] {
  return sessions
    .filter((session) => isBoardableObserved(session, now))
    .sort(compareBoardableObserved);
}
