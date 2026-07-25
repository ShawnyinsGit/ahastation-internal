import type {
  RendererTaskEvent,
  RendererTaskSnapshot,
  TaskMessage,
} from '../types';

const MAX_TASK_ACTIVITY = 500;
const MAX_SEEN_EVENTS = 2_000;

export interface TaskInspectorProjection {
  snapshot: RendererTaskSnapshot;
  activity: RendererTaskEvent[];
  lastSeq: number;
  seenEventIds: string[];
  needsRefresh: boolean;
  diagnostic?: string;
}

export function hydrateTaskProjection(
  snapshot: RendererTaskSnapshot,
): TaskInspectorProjection {
  return {
    snapshot: structuredClone(snapshot),
    activity: [],
    lastSeq: snapshot.lastSeq,
    seenEventIds: [],
    needsRefresh: false,
  };
}

function updateMailboxStatus(
  mailbox: TaskMessage[],
  messageId: string,
  status: TaskMessage['status'],
): TaskMessage[] {
  return mailbox.map((message) => (
    message.id === messageId ? { ...message, status } : message
  ));
}

function applyTaskEvent(
  snapshot: RendererTaskSnapshot,
  event: RendererTaskEvent,
): RendererTaskSnapshot {
  const data = event.data && typeof event.data === 'object'
    ? event.data as Record<string, unknown>
    : {};
  if (event.type === 'task-message-enqueued') {
    const message = data.message;
    if (message && typeof message === 'object') {
      const candidate = message as TaskMessage;
      if (
        candidate.taskId === snapshot.task.id
        && !snapshot.mailbox.some((entry) => entry.id === candidate.id)
      ) {
        return {
          ...snapshot,
          mailbox: [...snapshot.mailbox, structuredClone(candidate)]
            .sort((left, right) => left.seq - right.seq),
          lastSeq: event.seq,
        };
      }
    }
  }
  if (
    event.type === 'task-message-delivered'
    || event.type === 'task-message-acknowledged'
    || event.type === 'task-message-failed'
  ) {
    const messageId = typeof data.messageId === 'string' ? data.messageId : '';
    const status: TaskMessage['status'] = event.type === 'task-message-delivered'
      ? 'delivered'
      : event.type === 'task-message-acknowledged'
        ? 'acknowledged'
        : 'queued';
    return {
      ...snapshot,
      mailbox: updateMailboxStatus(snapshot.mailbox, messageId, status),
      lastSeq: event.seq,
    };
  }
  if (event.type === 'task-plan-state') {
    return {
      ...snapshot,
      task: {
        ...snapshot.task,
        ...(typeof data.status === 'string' ? { status: data.status } : {}),
        ...(Array.isArray(data.deps)
          ? { deps: data.deps.filter((entry): entry is string => typeof entry === 'string') }
          : {}),
      },
      lastSeq: event.seq,
    };
  }
  if (event.type.startsWith('coordinator-review-')) {
    const review = data.review && typeof data.review === 'object'
      ? data.review as Record<string, unknown>
      : null;
    if (review && typeof review.id === 'string' && typeof review.status === 'string') {
      const confirmations = Array.isArray(review.confirmations)
        ? review.confirmations.filter(
            (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'),
          )
        : [];
      const confirmed = new Set(confirmations.map((entry) => (
        `${String(entry.chunkId ?? '')}\0${String(entry.chunkHash ?? '')}`
      )));
      const pending = (Array.isArray(review.chunkEvidence) ? review.chunkEvidence : [])
        .filter(
          (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'),
        )
        .filter((chunk) => chunk.requiresUserConfirmation === true)
        .filter((chunk) => !confirmed.has(`${String(chunk.id ?? '')}\0${String(chunk.hash ?? '')}`))
        .map((chunk) => ({
          chunkId: String(chunk.id ?? ''),
          chunkHash: String(chunk.hash ?? ''),
          path: String(chunk.path ?? 'withheld evidence'),
          kind: String(chunk.kind ?? 'withheld'),
          byteLength: typeof chunk.byteLength === 'number' ? chunk.byteLength : 0,
          lineCount: typeof chunk.lineCount === 'number' ? chunk.lineCount : 0,
        }))
        .filter((chunk) => chunk.chunkId && /^[a-f0-9]{64}$/i.test(chunk.chunkHash));
      const covered = new Set([
        ...(Array.isArray(review.reviews) ? review.reviews : [])
          .map((entry) => String((entry as Record<string, unknown> | null)?.chunkId ?? '')),
        ...confirmations.map((entry) => String(entry.chunkId ?? '')),
      ]);
      const uncoveredChunkIds = (Array.isArray(review.chunkEvidence) ? review.chunkEvidence : [])
        .map((chunk) => String((chunk as Record<string, unknown> | null)?.id ?? ''))
        .filter((chunkId) => chunkId && !covered.has(chunkId))
        .slice(0, 20);
      return {
        ...snapshot,
        reviewEvidence: {
          reviewId: review.id,
          status: review.status,
          pending,
          uncoveredChunkIds,
          ...(typeof review.pauseReason === 'string' && review.pauseReason
            ? { pauseReason: review.pauseReason }
            : {}),
        },
        lastSeq: event.seq,
      };
    }
  }
  return { ...snapshot, lastSeq: event.seq };
}

/** Idempotent renderer projection. `previousSeq` is the Meeting-global seq of
 * the previous event for this same task, so unrelated Meeting events do not
 * create false gaps. */
export function reduceTaskEvent(
  current: TaskInspectorProjection,
  event: RendererTaskEvent,
): TaskInspectorProjection {
  if (event.taskId !== current.snapshot.task.id) return current;
  if (current.seenEventIds.includes(event.eventId) || event.seq <= current.lastSeq) {
    return current;
  }
  if (event.previousSeq !== current.lastSeq) {
    return {
      ...current,
      needsRefresh: true,
      diagnostic: `task event gap: expected predecessor ${current.lastSeq}, received ${event.previousSeq}`,
    };
  }
  const seenEventIds = [...current.seenEventIds, event.eventId].slice(-MAX_SEEN_EVENTS);
  const activity = [...current.activity, structuredClone(event)].slice(-MAX_TASK_ACTIVITY);
  return {
    snapshot: applyTaskEvent(current.snapshot, event),
    activity,
    lastSeq: event.seq,
    seenEventIds,
    needsRefresh: false,
  };
}
