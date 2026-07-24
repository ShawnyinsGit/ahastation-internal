import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export interface PersistedMeetingEvent {
  seq: number;
  ts: number;
  meetingId: string;
  type: string;
  payload: unknown;
}

/** Append-only durable journal for orchestration state. Writes are serialized
 * so a crash can lose at most the last partial line, which replay ignores. */
export class MeetingRepository {
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly meetingId: string, initialSeq = 0) {
    this.seq = initialSeq;
  }

  private root(): string {
    return join(app.getPath('userData'), 'meetings', this.meetingId);
  }

  /** Immutable delivery evidence lives beside the journal, never in a task
   * worktree or the user's project checkout. */
  deliveryArtifactRoot(): string {
    return join(this.root(), 'deliveries');
  }

  private eventPath(): string {
    return join(this.root(), 'events.jsonl');
  }

  append(type: string, payload: unknown): Promise<void> {
    const event: PersistedMeetingEvent = {
      seq: ++this.seq,
      ts: Date.now(),
      meetingId: this.meetingId,
      type,
      payload,
    };
    const run = this.tail.then(async () => {
      const path = this.eventPath();
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await fs.appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
    });
    this.tail = run.catch(() => {});
    return run;
  }

  snapshot(state: unknown): Promise<void> {
    const run = this.tail.then(async () => {
      const path = join(this.root(), 'snapshot.json');
      const tmp = `${path}.${process.pid}.tmp`;
      await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 2, seq: this.seq, state }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      await fs.rename(tmp, path);
    });
    this.tail = run.catch(() => {});
    return run;
  }

  flush(): Promise<void> {
    return this.tail;
  }

  static async replay(meetingId: string): Promise<PersistedMeetingEvent[]> {
    const path = join(app.getPath('userData'), 'meetings', meetingId, 'events.jsonl');
    try {
      const raw = await fs.readFile(path, 'utf8');
      const events: PersistedMeetingEvent[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line) as PersistedMeetingEvent); } catch { /* ignore torn tail */ }
      }
      return events;
    } catch { return []; }
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
        } catch { /* ignore corrupt snapshot */ }
      }
      return out;
    } catch { return []; }
  }
}
