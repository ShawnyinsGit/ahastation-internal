// useMeetingSelector.ts — fine-grained subscriptions to meetingStore slices.
//
// useSyncExternalStore re-renders a component whenever the snapshot reference
// it receives changes. The store emits one immutable MeetingState per slot
// mutation, so a whole-snapshot subscriber (useWorkers) re-renders on EVERY
// event — including per-frame ASR partials and activity appends. This hook
// lets a component subscribe to a derived slice instead: the selector result
// is memoized per snapshot and optionally compared with a custom equality,
// so unrelated mutations produce the same reference and React bails out.

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { meetingStore, type MeetingState } from '../lib/meeting-store';

export function useMeetingSelector<T>(
  selector: (state: MeetingState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  // Latest refs written during render: if a render is aborted the new
  // selector is still the one we want going forward, so this is safe here.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cacheRef = useRef<{ snapshot: MeetingState; selection: T } | null>(null);

  const getSelection = useCallback((): T => {
    const snapshot = meetingStore.getSnapshot();
    const cache = cacheRef.current;
    if (cache && cache.snapshot === snapshot) return cache.selection;
    const next = selectorRef.current(snapshot);
    // Preserve the previous reference when the custom equality says the slice
    // is unchanged — this is what lets React skip the re-render.
    if (cache && isEqualRef.current?.(cache.selection, next)) {
      cacheRef.current = { snapshot, selection: cache.selection };
      return cache.selection;
    }
    cacheRef.current = { snapshot, selection: next };
    return next;
  }, []);

  return useSyncExternalStore(meetingStore.subscribe, getSelection);
}

/** Shallow element-wise equality for array-typed selections. */
export function shallowEqualArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}
