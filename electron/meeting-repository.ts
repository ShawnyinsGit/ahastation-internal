import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PersistedMeetingEvent {
  id: string;
  seq: number;
  ts: number;
  meetingId: string;
  type: string;
  payload: unknown;
}

export interface PersistedTaskEventEnvelope<T = unknown> {
  schemaVersion: 1;
  taskId: string;
  attempt?: number;
  data: T;
}

export interface MeetingRepositoryOptions {
  /** Direct Meeting directory override used by deterministic tests. */
  rootDir?: string;
}

const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_REPLAY_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_DEPTH = 64;
const MAX_PAYLOAD_NODES = 100_000;

function assertBoundedJson(value: unknown): string {
  let nodes = 0;
  const active = new WeakSet<object>();
  function walk(current: unknown, depth: number): void {
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) throw new Error('Meeting event payload has too many values');
    if (depth > MAX_PAYLOAD_DEPTH) throw new Error('Meeting event payload is too deeply nested');
    if (
      current === null
      || current === undefined
      || typeof current === 'string'
      || typeof current === 'boolean'
      || (typeof current === 'number' && Number.isFinite(current))
    ) return;
    if (typeof current !== 'object') {
      throw new Error(`Meeting event payload is not JSON-safe: ${typeof current}`);
    }
    if (active.has(current)) throw new Error('Meeting event payload contains a cycle');
    active.add(current);
    if (Array.isArray(current)) {
      for (const entry of current) walk(entry, depth + 1);
    } else {
      for (const [key, entry] of Object.entries(current)) {
        if (key.length > 4_096) throw new Error('Meeting event payload key is too long');
        walk(entry, depth + 1);
      }
    }
    active.delete(current);
  }
  walk(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Meeting event payload cannot be serialized');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
    throw new Error('Meeting event payload exceeds the durable journal limit');
  }
  return serialized;
}

function normalizeEvent(
  meetingId: string,
  parsed: Partial<PersistedMeetingEvent>,
): PersistedMeetingEvent | null {
  if (
    typeof parsed.seq !== 'number'
    || !Number.isSafeInteger(parsed.seq)
    || parsed.seq <= 0
    || typeof parsed.ts !== 'number'
    || !Number.isFinite(parsed.ts)
    || typeof parsed.type !== 'string'
    || !parsed.type
  ) return null;
  return {
    id: typeof parsed.id === 'string' && parsed.id
      ? parsed.id
      : `${meetingId}:${parsed.seq}`,
    seq: parsed.seq,
    ts: parsed.ts,
    meetingId,
    type: parsed.type,
    payload: parsed.payload,
  };
}

/** Append-only durable journal for orchestration state. Calls reserve a stable
 * Meeting sequence in invocation order. A failed write permanently faults this
 * repository instance, so no later state can appear to overtake the gap. */
export class MeetingRepository {
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();
  private writeFault: Error | null = null;
  private pendingFault: Error | null = null;
  private subscribers = new Set<(event: PersistedMeetingEvent) => void>();

  constructor(
    private readonly meetingId: string,
    initialSeq = 0,
    private readonly options: MeetingRepositoryOptions = {},
  ) {
    this.seq = initialSeq;
  }

  private root(): string {
    return this.options.rootDir
      ?? join(app.getPath('userData'), 'meetings', this.meetingId);
  }

  /** Immutable delivery evidence lives beside the journal, never in a task
   * worktree or the user's project checkout. */
  deliveryArtifactRoot(): string {
    return join(this.root(), 'deliveries');
  }

  private eventPath(): string {
    return join(this.root(), 'events.jsonl');
  }

  isWriteFaulted(): boolean {
    return this.writeFault !== null || this.pendingFault !== null;
  }

  assertWritable(): void {
    if (this.writeFault) throw this.writeFault;
    if (this.pendingFault) throw this.pendingFault;
  }

  currentSequence(): number {
    return this.seq;
  }

  /** Subscribe to events only after their JSONL append has been fsynced.
   * Listener failures are isolated from the journal and from other readers. */
  subscribe(listener: (event: PersistedMeetingEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  append(type: string, payload: unknown): Promise<PersistedMeetingEvent> {
    if (!type.trim()) return Promise.reject(new Error('Meeting event type is required'));
    if (this.writeFault || this.pendingFault) {
      return Promise.reject(this.writeFault ?? this.pendingFault);
    }
    const seq = ++this.seq;
    const event: PersistedMeetingEvent = {
      id: randomUUID(),
      seq,
      ts: Date.now(),
      meetingId: this.meetingId,
      type,
      payload,
    };
    let line: string;
    try {
      // Validate before joining the write queue. The reserved sequence is not
      // reused; the instance faults so no later event can skip past it.
      assertBoundedJson(payload);
      line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) {
        throw new Error('Meeting event exceeds the durable journal limit');
      }
    } catch (error) {
      const fault = error instanceof Error ? error : new Error(String(error));
      this.pendingFault = fault;
      const result = this.tail.then(() => {
        this.writeFault = fault;
        this.pendingFault = null;
        throw fault;
      });
      this.tail = result.then(() => undefined, () => undefined);
      return result;
    }

    const run = this.tail.then(async () => {
      if (this.writeFault) throw this.writeFault;
      const path = this.eventPath();
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const handle = await fs.open(path, 'a', 0o600);
      try {
        await handle.writeFile(line, { encoding: 'utf8' });
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    const result = run.then(() => {
      for (const listener of this.subscribers) {
        try {
          listener(structuredClone(event));
        } catch {
          // A renderer observer cannot fault durable Meeting writes.
        }
      }
      return event;
    }).catch((error) => {
      if (!this.writeFault) {
        this.writeFault = error instanceof Error ? error : new Error(String(error));
      }
      throw this.writeFault;
    });
    // Keep the serialization queue observable but non-rejecting internally;
    // callers receive `result`, while subsequent work checks writeFault.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  appendTaskEvent<T>(
    type: string,
    envelope: PersistedTaskEventEnvelope<T>,
  ): Promise<PersistedMeetingEvent> {
    if (!envelope.taskId.trim()) return Promise.reject(new Error('taskId is required'));
    if (envelope.attempt !== undefined && (!Number.isSafeInteger(envelope.attempt) || envelope.attempt <= 0)) {
      return Promise.reject(new Error('task attempt must be a positive integer'));
    }
    return this.append(type, envelope);
  }

  snapshot(state: unknown): Promise<void> {
    if (this.writeFault || this.pendingFault) {
      return Promise.reject(this.writeFault ?? this.pendingFault);
    }
    let serialized: string;
    try {
      assertBoundedJson(state);
      serialized = JSON.stringify({ schemaVersion: 2, seq: this.seq, state }, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) {
        throw new Error('Meeting snapshot exceeds the durable storage limit');
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const run = this.tail.then(async () => {
      if (this.writeFault) throw this.writeFault;
      const path = join(this.root(), 'snapshot.json');
      const tmp = `${path}.${process.pid}.tmp`;
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
      if (process.platform === 'win32') {
        // Windows does not consistently replace an existing destination with
        // rename. Snapshot is a rebuildable projection; the journal remains
        // the source of truth during this brief exact-file replacement.
        await fs.rm(path, { force: true });
      }
      await fs.rename(tmp, path);
    });
    const result = run;
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async flush(): Promise<void> {
    await this.tail;
    this.assertWritable();
  }

  async replayAll(): Promise<PersistedMeetingEvent[]> {
    await this.flush();
    return MeetingRepository.replay(this.meetingId, this.options.rootDir);
  }

  static async replay(
    meetingId: string,
    rootDir?: string,
  ): Promise<PersistedMeetingEvent[]> {
    const path = join(
      rootDir ?? join(app.getPath('userData'), 'meetings', meetingId),
      'events.jsonl',
    );
    try {
      const raw = await fs.readFile(path, 'utf8');
      const events: PersistedMeetingEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          const event = normalizeEvent(
            meetingId,
            JSON.parse(line) as Partial<PersistedMeetingEvent>,
          );
          if (event) events.push(event);
        } catch {
          // A crash can leave one partial final JSONL line.
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  static async replayAfter(
    meetingId: string,
    afterSeq: number,
    limit: number,
    rootDir?: string,
  ): Promise<{
    events: PersistedMeetingEvent[];
    nextAfterSeq: number;
    hasMore: boolean;
  }> {
    const boundedAfter = Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? afterSeq : 0;
    const boundedLimit = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 1));
    const path = join(
      rootDir ?? join(app.getPath('userData'), 'meetings', meetingId),
      'events.jsonl',
    );
    const events: PersistedMeetingEvent[] = [];
    let outputBytes = 0;
    let hasMore = false;
    try {
      const raw = await fs.readFile(path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line) continue;
        let event: PersistedMeetingEvent | null = null;
        try {
          event = normalizeEvent(
            meetingId,
            JSON.parse(line) as Partial<PersistedMeetingEvent>,
          );
        } catch {
          // Ignore a torn final line and malformed historical entries.
        }
        if (!event || event.seq <= boundedAfter) continue;
        const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        if (
          events.length >= boundedLimit
          || outputBytes + eventBytes > MAX_REPLAY_PAGE_BYTES
        ) {
          hasMore = true;
          break;
        }
        events.push(event);
        outputBytes += eventBytes;
      }
    } catch {
      // Missing journals have an empty replay.
    }
    return {
      events,
      nextAfterSeq: events.at(-1)?.seq ?? boundedAfter,
      hasMore,
    };
  }

  static async listRecoverable(): Promise<Array<{ meetingId: string; seq: number; state: Record<string, unknown> }>> {
    const root = join(app.getPath('userData'), 'meetings');
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const out: Array<{ meetingId: string; seq: number; state: Record<string, unknown> }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const raw = await fs.readFile(join(root, entry.name, 'snapshot.json'), 'utf8');
          const parsed = JSON.parse(raw) as { seq?: unknown; state?: Record<string, unknown> };
          if (!parsed.state || parsed.state.status !== 'active') continue;
          const tasks = Array.isArray(parsed.state.tasks)
            ? parsed.state.tasks.map((task: Record<string, unknown>) => ({
                ...task,
                status: (
                  task.status === 'accepted'
                  || task.status === 'done'
                  || task.status === 'failed'
                ) ? task.status : 'interrupted',
              }))
            : [];
          out.push({
            meetingId: entry.name,
            seq: typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) && parsed.seq >= 0
              ? parsed.seq
              : 0,
            state: { ...parsed.state, status: 'recovering', tasks },
          });
        } catch {
          // Ignore corrupt snapshots; their append-only journal remains.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
}
