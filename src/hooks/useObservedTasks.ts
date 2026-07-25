import { useSyncExternalStore } from 'react';
import { observedStore, type ObservedSnapshot } from '../lib/observed-store';

/** Latest observed-session snapshot from the main-process observation layer.
 *  Stays empty until the first scan lands — and permanently empty when the
 *  preload predates the observe namespace (the board then shows nothing
 *  observed, by design). */
export function useObservedTasks(): ObservedSnapshot {
  return useSyncExternalStore(observedStore.subscribe, observedStore.getSnapshot);
}
