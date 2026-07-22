// display-migration.ts — renderer mirror of electron/display-migration.ts
// (hand-synced; the two tsconfigs don't share sources).

export type HandheldOverride = 'auto' | 'handheld' | 'desktop';
export type UiMode = 'handheld' | 'desktop';

export interface DisplayMigrationInput {
  override: HandheldOverride;
  modeBefore: UiMode;
  modeAfter: UiMode;
  overlay: { open: boolean; hostId: string | null };
  editorWindows: string[];
}

export type DisplayMigrationAction =
  | { kind: 'overlay-to-window'; hostId: string }
  | { kind: 'window-to-overlay'; hostId: string };

export function planDisplayMigration(input: DisplayMigrationInput): DisplayMigrationAction[] {
  if (input.override !== 'auto') return [];
  if (input.modeBefore === input.modeAfter) return [];

  if (input.modeBefore === 'handheld' && input.modeAfter === 'desktop') {
    return input.overlay.open && input.overlay.hostId
      ? [{ kind: 'overlay-to-window', hostId: input.overlay.hostId }]
      : [];
  }
  if (input.modeBefore === 'desktop' && input.modeAfter === 'handheld') {
    return input.editorWindows.length > 0
      ? [{ kind: 'window-to-overlay', hostId: input.editorWindows[0] }]
      : [];
  }
  return [];
}
