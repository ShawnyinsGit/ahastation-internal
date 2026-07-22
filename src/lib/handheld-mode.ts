// handheld-mode.ts — renderer mirror of electron/handheld-mode.ts (pure fn,
// hand-synced) plus the useHandheldMode hook. The hook resolves the mode
// from the persisted three-way override + auto heuristic and drives the
// root <html> class ('handheld' / 'desktop') — ALL layout overrides hang
// off that class; width breakpoints only fine-tune within a mode.

import { useCallback, useEffect, useState } from 'react';

export type HandheldOverride = 'auto' | 'handheld' | 'desktop';
export type UiMode = 'handheld' | 'desktop';

export const HANDHELD_AUTO_MAX_SCREEN_WIDTH = 1300;

export function resolveUiMode(
  override: HandheldOverride,
  pointerCoarse: boolean,
  screenWidth: number,
): UiMode {
  if (override === 'handheld') return 'handheld';
  if (override === 'desktop') return 'desktop';
  return pointerCoarse && screenWidth <= HANDHELD_AUTO_MAX_SCREEN_WIDTH
    ? 'handheld'
    : 'desktop';
}

export function useHandheldMode(): {
  mode: UiMode;
  override: HandheldOverride;
  setOverride: (v: HandheldOverride) => void;
} {
  const [override, setOverrideState] = useState<HandheldOverride>('auto');
  const [signals, setSignals] = useState<{ coarse: boolean; width: number }>(() => ({
    coarse: typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
    width: typeof window !== 'undefined' ? window.screen.width : 1920,
  }));

  // Load the persisted override once.
  useEffect(() => {
    let cancelled = false;
    window.vibeMeet.getVoicePref().then((pref) => {
      if (!cancelled) setOverrideState(pref.handheldMode);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Track the auto-heuristic inputs. The display-changed IPC (Phase 6a) is
  // the RELIABLE signal here: a window moved across displays changes
  // screen.width without necessarily firing a window 'resize' event.
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setSignals({ coarse: mq.matches, width: window.screen.width });
    mq.addEventListener('change', update);
    window.addEventListener('resize', update);
    const disposeDisplay = window.vibeMeet.onDisplayChanged?.(update);
    return () => {
      mq.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      disposeDisplay?.();
    };
  }, []);

  const mode = resolveUiMode(override, signals.coarse, signals.width);

  // Drive the root class from the resolved mode.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('handheld', mode === 'handheld');
    root.classList.toggle('desktop', mode === 'desktop');
  }, [mode]);

  const setOverride = useCallback((v: HandheldOverride) => {
    setOverrideState(v);
    void window.vibeMeet.setVoicePref({ handheldMode: v });
  }, []);

  return { mode, override, setOverride };
}
