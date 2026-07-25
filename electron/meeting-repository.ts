import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assessTaskRecovery,
  normalizeRecoveredTaskStatus,
} from './task-recovery.js';

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

/** Module-load timestamp. Snapshot tmp files older than this belong to a
 *  previous (crashed) run and are safe to reap; a concurrent writer's fresh
 *  tmp is always newer. */
const PROCESS_EPOCH_MS = Date.now();

const SNAPSHOT_TMP_PATTERN = /^snapshot\.json\..+\.tmp$/;

/** Best-effort removal of snapshot tmp leftovers from crashed runs. Only
 *  called once a good snapshot.json exists, so a tmp that is still the sole
 *  surviving projection is never deleted. */
async function removeStaleSnapshotTmps(dir: string): Promise<void> {
  try {
    for (const name of await fs.readdir(dir)) {
      if (!SNAPSHOT_TMP_PATTERN.test(name)) continue;
      const full = join(dir, name);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs < PROCESS_EPOCH_MS) await fs.rm(full, { force: true });
      } catch {
        // Best-effort cleanup must never fault snapshot writes or recovery.
      }
    }
  } catch {
    // Ignore unreadable directories.
  }
}

/** Read the durable snapshot projection, falling back to the newest
 *  snapshot.json.<pid>.tmp. A crash between the tmp write and the rename
 *  (the win32 replace window) leaves a fully serialized snapshot in the tmp
 *  file, so recovery must not depend on the rename having completed. */
async function readSnapshotProjection(
  dir: string,
): Promise<{
  parsed: { seq?: unknown; state?: Record<string, unknown> };
  source: 'snapshot' | 'tmp';
} | null> {
  try {
    return {
      parsed: JSON.parse(await fs.readFile(join(dir, 'snapshot.json'), 'utf8')),
      source: 'snapshot',
    };
  } catch {
    // Fall through to the tmp fallback below.
  }
  try {
    let newest: string | null = null;
    let newestMtime = -Infinity;
    for (const name of await fs.readdir(dir)) {
      if (!SNAPSHOT_TMP_PATTERN.test(name)) continue;
      try {
        const stat = await fs.stat(join(dir, name));
        if (stat.mtimeMs > newestMtime) {
          newestMtime = stat.mtimeMs;
          newest = name;
        }
      } catch {
        // Skip unreadable candidates.
      }
    }
    if (!newest) return null;
    return {
      parsed: JSON.parse(await fs.readFile(join(dir, newest), 'utf8')),
      source: 'tmp',
    };
  } catch {
    return null;
  }
}

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
      serialized = JSON.stringify({ schemaVersion: 3, seq: this.seq, state }, null, 2);
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
      try {
        // rename replaces an existing destination atomically on POSIX and via
        // MOVEFILE_REPLACE_EXISTING on Windows. Only when Windows refuses the
        // replacement (file locks, EPERM/EACCES/EEXIST) fall back to
        // rm + rename — keeping the no-snapshot window confined to that rare
        // retry path instead of every save.
        await fs.rename(tmp, path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST')) {
          await fs.rm(path, { force: true });
          await fs.rename(tmp, path);
        } else {
          throw error;
        }
      }
      await removeStaleSnapshotTmps(dirname(path));
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
          const dir = join(root, entry.name);
          const journal = await MeetingRepository.replay(entry.name, dir);
          const journalTailSeq = journal.at(-1)?.seq ?? 0;
          const latestTaskStatuses = new Map<string, unknown>();
          const latestTaskNodes = new Map<string, Record<string, unknown>>();
          let journalCwd: string | null = null;
          for (const event of journal) {
            if (
              (event.type === 'meeting-created' || event.type === 'meeting-recovered')
              && event.payload && typeof event.payload === 'object'
              && typeof (event.payload as Record<string, unknown>).cwd === 'string'
            ) {
              journalCwd = (event.payload as Record<string, unknown>).cwd as string;
            }
            if (event.type !== 'event:plan-updated') continue;
            if (!event.payload || typeof event.payload !== 'object') continue;
            const rendererEvent = (event.payload as Record<string, unknown>).event;
            if (!rendererEvent || typeof rendererEvent !== 'object') continue;
            const plan = (rendererEvent as Record<string, unknown>).plan;
            if (!plan || typeof plan !== 'object') continue;
            const nodes = (plan as Record<string, unknown>).nodes;
            if (!Array.isArray(nodes)) continue;
            for (const node of nodes) {
              if (!node || typeof node !== 'object') continue;
              const record = node as Record<string, unknown>;
              if (typeof record.id !== 'string') continue;
              // Acceptance is monotonic: a delayed renderer/projection event
              // cannot take a durably accepted task back to a live state.
              if (latestTaskStatuses.get(record.id) === 'accepted') continue;
              latestTaskStatuses.set(record.id, record.status);
              latestTaskNodes.set(record.id, record);
            }
          }
          const projection = await readSnapshotProjection(dir);
          if (projection?.source === 'snapshot') {
            // A good snapshot.json makes leftovers from crashed runs garbage.
            await removeStaleSnapshotTmps(dir);
          }
          let parsed = projection?.parsed ?? null;
          if (!parsed?.state) {
            // No snapshot projection at all (crash before the first save).
            // The append-only journal is the source of truth, so rebuild the
            // minimal recovery state from it instead of dropping the meeting.
            if (journal.length === 0 || !journalCwd) continue;
            parsed = {
              seq: journalTailSeq,
              state: { status: 'active', cwd: journalCwd, hosts: [], tasks: [] },
            };
          }
          if (!parsed.state || parsed.state.status !== 'active') continue;
          // A stale/empty snapshot task list falls back to the journal's plan
          // nodes so tasks planned after the last save still surface.
          const baseTasks = Array.isArray(parsed.state.tasks) && parsed.state.tasks.length > 0
            ? parsed.state.tasks
            : [...latestTaskNodes.values()];
          const tasks = baseTasks
            .filter((task): task is Record<string, unknown> => (
              Boolean(task && typeof task === 'object' && !Array.isArray(task))
            ))
            .map((task) => {
              const latestStatus = typeof task.id === 'string'
                ? latestTaskStatuses.get(task.id)
                : undefined;
              const normalized = {
                ...task,
                status: normalizeRecoveredTaskStatus(latestStatus ?? task.status),
              };
              return {
                ...normalized,
                recovery: assessTaskRecovery(normalized),
              };
            });
          out.push({
            meetingId: entry.name,
            seq: Math.max(
              journalTailSeq,
              typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) && parsed.seq >= 0
                ? parsed.seq
                : 0,
            ),
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
