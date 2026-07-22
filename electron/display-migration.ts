// display-migration.ts — pure migration planner for dual-display transitions
// (Phase 6a, §3.2). Given the UI mode BEFORE and AFTER a display change plus
// the current editor form-factor state, decide the ordered action list. The
// renderer executes these against real IPC; the planner itself is pure and
// unit-tested. Auto-mode only — forced handheld/desktop never auto-migrates
// (that is the setting's documented semantics).

import type { HandheldOverride, UiMode } from './handheld-mode.js';

export interface DisplayMigrationInput {
  override: HandheldOverride;
  /** Resolved mode before the display change. */
  modeBefore: UiMode;
  /** Resolved mode after the display change. */
  modeAfter: UiMode;
  /** Overlay currently open in the meeting UI (with its hostId). */
  overlay: { open: boolean; hostId: string | null };
  /** hostIds with an independent editor window open. */
  editorWindows: string[];
}

export type DisplayMigrationAction =
  | { kind: 'overlay-to-window'; hostId: string }
  | { kind: 'window-to-overlay'; hostId: string };

/** Mode flip handheld→desktop: the overlay becomes an independent window
 *  (scene restored from the scene store). desktop→handheld: independent
 *  windows collapse back into the overlay. Same-mode transitions and
 *  forced overrides are no-ops. */
export function planDisplayMigration(input: DisplayMigrationInput): DisplayMigrationAction[] {
  if (input.override !== 'auto') return [];
  if (input.modeBefore === input.modeAfter) return [];

  if (input.modeBefore === 'handheld' && input.modeAfter === 'desktop') {
    return input.overlay.open && input.overlay.hostId
      ? [{ kind: 'overlay-to-window', hostId: input.overlay.hostId }]
      : [];
  }
  // desktop → handheld: collapse windows into a single overlay (the first
  // window's host becomes the overlay's subject; the user can chip-switch).
  if (input.modeBefore === 'desktop' && input.modeAfter === 'handheld') {
    return input.editorWindows.length > 0
      ? [{ kind: 'window-to-overlay', hostId: input.editorWindows[0] }]
      : [];
  }
  return [];
}
