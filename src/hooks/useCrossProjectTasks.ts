import { useSyncExternalStore } from 'react';
import { meetingStore, type CrossProjectTasks } from '../lib/meeting-store';

/** Every project's tasks in one list, for the cross-project board. Rides the
 *  tab listener set because that one fires on any slot's mutation, not just the
 *  active slot's — a background project finishing a task has to move its card. */
export function useCrossProjectTasks(): CrossProjectTasks {
  return useSyncExternalStore(meetingStore.subscribeTabs, meetingStore.getCrossProjectTasks);
}
