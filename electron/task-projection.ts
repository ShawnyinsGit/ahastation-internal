import {
  meetingTaskRecordSchema,
  meetingTaskStatusSchema,
  taskAttemptRecordSchema,
  taskMessageSchema,
  type MeetingTaskRecord,
  type MeetingTaskStatus,
} from './task-collaboration.js';
import type {
  PersistedMeetingEvent,
  PersistedTaskEventEnvelope,
} from './meeting-repository.js';

export interface TaskProjectionDiagnostic {
  eventId: string;
  eventSeq: number;
  taskId?: string;
  code:
    | 'invalid-envelope'
    | 'invalid-record'
    | 'unknown-task'
    | 'duplicate-task'
    | 'invalid-transition'
    | 'stale-event'
    | 'invalid-message'
    | 'invalid-attempt';
  message: string;
}

export interface TaskProjectionResult {
  tasks: MeetingTaskRecord[];
  diagnostics: TaskProjectionDiagnostic[];
}

const TERMINAL_STATUSES = new Set<MeetingTaskStatus>(['accepted', 'failed', 'cancelled']);
const ALLOWED_TRANSITIONS: Record<MeetingTaskStatus, ReadonlySet<MeetingTaskStatus>> = {
  draft: new Set(['pending', 'cancelled']),
  pending: new Set(['running', 'blocked', 'interrupted', 'failed', 'cancelled']),
  running: new Set(['verifying', 'blocked', 'reworking', 'interrupted', 'failed', 'cancelled']),
  verifying: new Set(['coordinator-reviewing', 'reworking', 'blocked', 'failed', 'cancelled']),
  'coordinator-reviewing': new Set(['integration-queued', 'reworking', 'blocked', 'failed', 'cancelled']),
  'integration-queued': new Set(['integrating', 'reworking', 'integration-conflict', 'failed', 'cancelled']),
  integrating: new Set(['accepted', 'reworking', 'integration-conflict', 'failed']),
  accepted: new Set(),
  blocked: new Set(['pending', 'running', 'reworking', 'failed', 'cancelled']),
  reworking: new Set(['pending', 'running', 'blocked', 'budget-paused', 'failed', 'cancelled']),
  'integration-conflict': new Set(['reworking', 'failed', 'cancelled']),
  'budget-paused': new Set(['reworking', 'failed', 'cancelled']),
  interrupted: new Set(['pending', 'reworking', 'failed', 'cancelled']),
  failed: new Set(['reworking']),
  cancelled: new Set(),
};

function parseEnvelope(
  event: PersistedMeetingEvent,
): PersistedTaskEventEnvelope<unknown> | null {
  if (event.payload === null || typeof event.payload !== 'object') return null;
  const value = event.payload as Partial<PersistedTaskEventEnvelope<unknown>>;
  if (
    value.schemaVersion !== 1
    || typeof value.taskId !== 'string'
    || !value.taskId.trim()
    || (
      value.attempt !== undefined
      && (!Number.isSafeInteger(value.attempt) || value.attempt <= 0)
    )
  ) return null;
  return value as PersistedTaskEventEnvelope<unknown>;
}

function diagnostic(
  event: PersistedMeetingEvent,
  code: TaskProjectionDiagnostic['code'],
  message: string,
  taskId?: string,
): TaskProjectionDiagnostic {
  return {
    eventId: event.id,
    eventSeq: event.seq,
    ...(taskId ? { taskId } : {}),
    code,
    message,
  };
}

function isMailboxEvent(type: string): boolean {
  return type === 'task-message-enqueued'
    || type === 'task-message-delivered'
    || type === 'task-message-acknowledged'
    || type === 'task-message-failed';
}

/** Pure recovery projection. Meeting event cursor and task-local mailbox cursor
 * remain separate facts and are never compared to each other. Impossible
 * historical transitions produce bounded diagnostics instead of crashing
 * Meeting recovery. */
export function projectMeetingTasks(
  events: readonly PersistedMeetingEvent[],
  seeds: readonly MeetingTaskRecord[] = [],
): TaskProjectionResult {
  const tasks = new Map<string, MeetingTaskRecord>();
  const diagnostics: TaskProjectionDiagnostic[] = [];
  const appliedEventIds = new Set<string>();

  for (const seed of seeds) {
    const parsed = meetingTaskRecordSchema.safeParse(seed);
    if (parsed.success) tasks.set(parsed.data.id, structuredClone(parsed.data));
  }

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (appliedEventIds.has(event.id)) continue;
    appliedEventIds.add(event.id);
    if (!event.type.startsWith('task-')) continue;
    const envelope = parseEnvelope(event);
    if (!envelope) {
      diagnostics.push(diagnostic(event, 'invalid-envelope', 'task event envelope is invalid'));
      continue;
    }
    const taskId = envelope.taskId;
    if (event.type === 'task-record-created') {
      const parsed = meetingTaskRecordSchema.safeParse(envelope.data);
      if (!parsed.success || parsed.data.id !== taskId) {
        diagnostics.push(diagnostic(event, 'invalid-record', 'task record is invalid', taskId));
        continue;
      }
      if (tasks.has(taskId)) {
        diagnostics.push(diagnostic(event, 'duplicate-task', 'task record already exists', taskId));
        const existing = tasks.get(taskId)!;
        if (event.seq > existing.eventCursor) {
          tasks.set(taskId, { ...existing, eventCursor: event.seq });
        }
        continue;
      }
      tasks.set(taskId, {
        ...structuredClone(parsed.data),
        eventCursor: event.seq,
      });
      continue;
    }

    const current = tasks.get(taskId);
    if (!current) {
      diagnostics.push(diagnostic(event, 'unknown-task', 'task event has no task record', taskId));
      continue;
    }
    if (event.seq <= current.eventCursor) {
      diagnostics.push(diagnostic(event, 'stale-event', 'task event does not advance the Meeting cursor', taskId));
      continue;
    }

    if (event.type === 'task-status-changed') {
      const data = envelope.data as { status?: unknown };
      const parsedStatus = meetingTaskStatusSchema.safeParse(data?.status);
      if (!parsedStatus.success) {
        diagnostics.push(diagnostic(event, 'invalid-transition', 'task status is invalid', taskId));
        tasks.set(taskId, { ...current, eventCursor: event.seq });
        continue;
      }
      const next = parsedStatus.data;
      if (next !== current.status && !ALLOWED_TRANSITIONS[current.status].has(next)) {
        diagnostics.push(diagnostic(
          event,
          'invalid-transition',
          TERMINAL_STATUSES.has(current.status)
            ? 'terminal task status cannot be mutated'
            : `task transition ${current.status} -> ${next} is not allowed`,
          taskId,
        ));
        tasks.set(taskId, { ...current, eventCursor: event.seq });
        continue;
      }
      tasks.set(taskId, {
        ...current,
        status: next,
        eventCursor: event.seq,
      });
      continue;
    }

    if (event.type === 'task-attempt-recorded') {
      const parsedAttempt = taskAttemptRecordSchema.safeParse(envelope.data);
      if (!parsedAttempt.success || parsedAttempt.data.attempt !== envelope.attempt) {
        diagnostics.push(diagnostic(event, 'invalid-attempt', 'task attempt record is invalid', taskId));
        tasks.set(taskId, { ...current, eventCursor: event.seq });
        continue;
      }
      const attempts = current.attempts.filter(
        (attempt) => attempt.attempt !== parsedAttempt.data.attempt,
      );
      attempts.push(parsedAttempt.data);
      attempts.sort((left, right) => left.attempt - right.attempt);
      const candidate = {
        ...current,
        currentAttempt: Math.max(current.currentAttempt, parsedAttempt.data.attempt),
        attempts,
        eventCursor: event.seq,
      };
      const parsedRecord = meetingTaskRecordSchema.safeParse(candidate);
      if (!parsedRecord.success) {
        diagnostics.push(diagnostic(event, 'invalid-attempt', 'attempt conflicts with task authority', taskId));
        tasks.set(taskId, { ...current, eventCursor: event.seq });
        continue;
      }
      tasks.set(taskId, parsedRecord.data);
      continue;
    }

    if (isMailboxEvent(event.type)) {
      let messageSeq: number | undefined;
      if (event.type === 'task-message-enqueued') {
        const parsedMessage = taskMessageSchema.safeParse(envelope.data);
        if (!parsedMessage.success || parsedMessage.data.taskId !== taskId) {
          diagnostics.push(diagnostic(event, 'invalid-message', 'task message is invalid', taskId));
          tasks.set(taskId, { ...current, eventCursor: event.seq });
          continue;
        }
        messageSeq = parsedMessage.data.seq;
      } else {
        const data = envelope.data as { messageSeq?: unknown };
        if (typeof data?.messageSeq !== 'number' || !Number.isSafeInteger(data.messageSeq) || data.messageSeq <= 0) {
          diagnostics.push(diagnostic(event, 'invalid-message', 'message status has no task-local sequence', taskId));
          tasks.set(taskId, { ...current, eventCursor: event.seq });
          continue;
        }
        messageSeq = data.messageSeq;
      }
      tasks.set(taskId, {
        ...current,
        mailboxCursor: Math.max(current.mailboxCursor, messageSeq),
        eventCursor: event.seq,
      });
    }
  }

  return {
    tasks: Array.from(tasks.values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((task) => structuredClone(task)),
    diagnostics,
  };
}
