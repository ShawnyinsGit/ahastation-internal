import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  taskMessageSchema,
  type TaskMessage,
} from './task-collaboration.js';
import {
  type MeetingRepository,
  type PersistedMeetingEvent,
  type PersistedTaskEventEnvelope,
} from './meeting-repository.js';

export type NewTaskMessage = Omit<TaskMessage, 'schemaVersion' | 'seq' | 'status' | 'timestamp' | 'id'> & {
  id?: string;
};

export interface TaskMailboxOptions {
  /** Runs only after the enqueue event is durable. Task 9 uses this seam to
   * deliver to a Backend without racing crash recovery. */
  onDurableEnqueue?: (message: TaskMessage) => void | Promise<void>;
  getTaskLifecycle?: (taskId: string) => {
    currentAttempt: number;
    terminal: boolean;
  } | undefined;
}

const FORBIDDEN_NATIVE_PAYLOAD_KEYS = new Set([
  'nativepayload',
  'rawpayload',
  'backendpayload',
  'sdkmessage',
  'rawrequest',
  'rawresponse',
  'tooluseresult',
  'apikey',
  'access_token',
  'authorization',
  'credential',
]);

function assertNoNativePayload(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error('task message payload contains a cycle');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertNoNativePayload(entry, seen);
  } else {
    for (const [key, entry] of Object.entries(value)) {
      const normalized = key.replace(/[-_\s]/g, '').toLowerCase();
      if (FORBIDDEN_NATIVE_PAYLOAD_KEYS.has(normalized)) {
        throw new Error(`task message payload contains forbidden native field: ${key}`);
      }
      assertNoNativePayload(entry, seen);
    }
  }
  seen.delete(value);
}

function taskEnvelope(
  event: PersistedMeetingEvent,
): PersistedTaskEventEnvelope<unknown> | null {
  if (event.payload === null || typeof event.payload !== 'object') return null;
  const envelope = event.payload as Partial<PersistedTaskEventEnvelope<unknown>>;
  if (
    envelope.schemaVersion !== 1
    || typeof envelope.taskId !== 'string'
    || !envelope.taskId
    || (
      envelope.attempt !== undefined
      && (!Number.isSafeInteger(envelope.attempt) || envelope.attempt <= 0)
    )
  ) return null;
  return envelope as PersistedTaskEventEnvelope<unknown>;
}

/** Durable task-local mailbox. Its `seq` is scoped to taskId and deliberately
 * independent from the Meeting journal sequence returned by the repository. */
export class TaskMailbox {
  private messagesById = new Map<string, TaskMessage>();
  private idsByTask = new Map<string, string[]>();
  private nextSeqByTask = new Map<string, number>();

  constructor(
    private readonly repository: MeetingRepository,
    private readonly options: TaskMailboxOptions = {},
  ) {}

  restore(events: readonly PersistedMeetingEvent[]): void {
    this.messagesById.clear();
    this.idsByTask.clear();
    this.nextSeqByTask.clear();
    for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
      const envelope = taskEnvelope(event);
      if (!envelope) continue;
      if (event.type === 'task-message-enqueued') {
        const parsed = taskMessageSchema.safeParse(envelope.data);
        if (!parsed.success || parsed.data.taskId !== envelope.taskId) continue;
        if (this.messagesById.has(parsed.data.id)) continue;
        this.remember(parsed.data);
        continue;
      }
      if (
        event.type !== 'task-message-delivered'
        && event.type !== 'task-message-acknowledged'
        && event.type !== 'task-message-failed'
      ) continue;
      const data = envelope.data as { messageId?: unknown };
      if (typeof data?.messageId !== 'string') continue;
      const current = this.messagesById.get(data.messageId);
      if (!current || current.taskId !== envelope.taskId) continue;
      if (event.type === 'task-message-delivered' && current.status !== 'acknowledged') {
        this.messagesById.set(current.id, { ...current, status: 'delivered' });
      } else if (event.type === 'task-message-acknowledged') {
        this.messagesById.set(current.id, { ...current, status: 'acknowledged' });
      } else if (event.type === 'task-message-failed' && current.status !== 'acknowledged') {
        this.messagesById.set(current.id, { ...current, status: 'failed' });
      }
    }
    // A durable "delivered" event proves dispatch was attempted, not that the
    // Backend consumed it. Retry after restart without inventing an ack.
    for (const [id, message] of this.messagesById) {
      if (message.status === 'delivered') {
        this.messagesById.set(id, { ...message, status: 'queued' });
      }
    }
  }

  async enqueue(input: NewTaskMessage): Promise<TaskMessage> {
    assertNoNativePayload(input.payload);
    const id = input.id?.trim() || randomUUID();
    const existing = this.messagesById.get(id);
    if (existing) {
      const requested = {
        taskId: input.taskId,
        attempt: input.attempt,
        sender: input.sender,
        kind: input.kind,
        replyTo: input.replyTo,
        payload: input.payload,
      };
      const persisted = {
        taskId: existing.taskId,
        attempt: existing.attempt,
        sender: existing.sender,
        kind: existing.kind,
        replyTo: existing.replyTo,
        payload: existing.payload,
      };
      if (!isDeepStrictEqual(requested, persisted)) {
        throw new Error(`task message id already exists with different semantics: ${id}`);
      }
      return structuredClone(existing);
    }
    const lifecycle = this.options.getTaskLifecycle?.(input.taskId);
    if (
      lifecycle?.terminal
      && input.attempt <= lifecycle.currentAttempt
      && ['instruction', 'follow-up', 'steer', 'interrupt'].includes(input.kind)
    ) {
      throw new Error(
        `terminal task ${input.taskId} requires a new attempt before ${input.kind}`,
      );
    }
    const seq = (this.nextSeqByTask.get(input.taskId) ?? 0) + 1;
    const message = taskMessageSchema.parse({
      schemaVersion: 1,
      id,
      seq,
      taskId: input.taskId,
      attempt: input.attempt,
      sender: input.sender,
      kind: input.kind,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      payload: structuredClone(input.payload),
      status: 'queued',
      timestamp: Date.now(),
    });
    await this.repository.appendTaskEvent('task-message-enqueued', {
      schemaVersion: 1,
      taskId: message.taskId,
      attempt: message.attempt,
      data: message,
    });
    this.remember(message);
    await this.options.onDurableEnqueue?.(structuredClone(message));
    return structuredClone(message);
  }

  async markDelivered(taskId: string, messageId: string): Promise<TaskMessage> {
    const message = this.requireMessage(taskId, messageId);
    if (message.status === 'acknowledged' || message.status === 'delivered') {
      return structuredClone(message);
    }
    await this.appendStatus('task-message-delivered', message);
    return this.updateStatus(message, 'delivered');
  }

  async acknowledge(taskId: string, messageId: string): Promise<TaskMessage> {
    const message = this.requireMessage(taskId, messageId);
    if (message.status === 'acknowledged') return structuredClone(message);
    if (message.status !== 'delivered') {
      throw new Error(`task message ${messageId} must be delivered before acknowledgement`);
    }
    await this.appendStatus('task-message-acknowledged', message);
    return this.updateStatus(message, 'acknowledged');
  }

  async markFailed(taskId: string, messageId: string): Promise<TaskMessage> {
    const message = this.requireMessage(taskId, messageId);
    if (message.status === 'acknowledged') {
      throw new Error(`acknowledged task message ${messageId} cannot fail`);
    }
    if (message.status === 'failed') return structuredClone(message);
    await this.appendStatus('task-message-failed', message);
    return this.updateStatus(message, 'failed');
  }

  list(taskId: string, afterSeq = 0): TaskMessage[] {
    return (this.idsByTask.get(taskId) ?? [])
      .map((id) => this.messagesById.get(id))
      .filter((message): message is TaskMessage => Boolean(message && message.seq > afterSeq))
      .sort((left, right) => left.seq - right.seq)
      .map((message) => structuredClone(message));
  }

  private remember(message: TaskMessage): void {
    this.messagesById.set(message.id, structuredClone(message));
    const ids = this.idsByTask.get(message.taskId) ?? [];
    ids.push(message.id);
    this.idsByTask.set(message.taskId, ids);
    this.nextSeqByTask.set(
      message.taskId,
      Math.max(this.nextSeqByTask.get(message.taskId) ?? 0, message.seq),
    );
  }

  private requireMessage(taskId: string, messageId: string): TaskMessage {
    const message = this.messagesById.get(messageId);
    if (!message || message.taskId !== taskId) {
      throw new Error(`task message not found: ${taskId}/${messageId}`);
    }
    return message;
  }

  private async appendStatus(type: string, message: TaskMessage): Promise<void> {
    await this.repository.appendTaskEvent(type, {
      schemaVersion: 1,
      taskId: message.taskId,
      attempt: message.attempt,
      data: { messageId: message.id, messageSeq: message.seq },
    });
  }

  private updateStatus(
    message: TaskMessage,
    status: TaskMessage['status'],
  ): TaskMessage {
    const updated = { ...message, status };
    this.messagesById.set(message.id, updated);
    return structuredClone(updated);
  }
}
