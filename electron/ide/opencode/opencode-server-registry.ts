// opencode-server-registry.ts — shared opencode server registry (Phase 3).
//
// One `opencode serve` process per (meetingId, cwd): every participant AND
// editor window in the same meeting shares it (safe — the event pipeline
// attributes by sessionID since Phase 2 PR①; the instance-level visibility
// caveat is documented in §2.3). The registry owns:
//   - refcounting: each participant session acquires on start and releases
//     on end(); the last release kills the server,
//   - a table-driven lifecycle matrix (sessionEnd / windowClose / appQuit /
//     meetingDelete → release / keep / kill-all / kill),
//   - adopt-or-kill on first acquire: userData records from a previous run
//     (volatile runtime only — pid/port/startedAt/password, NEVER session
//     identity; the journal stays the single source of truth for that) are
//     probed per cwd, adopted when alive, swept when dead.
//
// spawn is caller-supplied (per-session config/env), probe/persist are
// injectable — the whole registry is unit-testable under plain node.

import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  basicAuthHeader,
  spawnOpencodeServer,
  type OpencodeServerHandle,
} from '../../backends/opencode-server-process.js';

// ── Lifecycle matrix (table-driven; handlers below just execute it) ────────

export const SERVER_LIFECYCLE_MATRIX = {
  /** Participant session end() → release a refcount (server dies at 0). */
  sessionEnd: 'release',
  /** Editor window closed → keep the server (re-attach pulls the snapshot). */
  windowClose: 'keep',
  /** App shutdown → kill every server. */
  appQuit: 'kill-all',
  /** Meeting tab deleted → kill the server regardless of refcount. */
  meetingDelete: 'kill',
} as const;

export type ServerLifecycleEvent = keyof typeof SERVER_LIFECYCLE_MATRIX;

// ── Pure key + records ──────────────────────────────────────────────────────

export function serverKeyOf(meetingId: string, cwd: string): string {
  return `${meetingId}\n${cwd}`;
}

export interface PersistedServerRecord {
  meetingId: string;
  cwd: string;
  pid: number | null;
  url: string;
  /** Basic-auth password — volatile runtime state, main-only file. Required
   *  for adopt-or-kill probing; never leaves the main process. */
  password: string;
  startedAt: number;
}

export interface OpencodeServerRegistryDeps {
  probe: (url: string, password: string) => Promise<boolean>;
  load: () => PersistedServerRecord[];
  save: (records: PersistedServerRecord[]) => void;
  now?: () => number;
}

interface LiveEntry {
  key: string;
  meetingId: string;
  cwd: string;
  handle: OpencodeServerHandle;
  refcount: number;
  startedAt: number;
}

export interface AcquiredServer {
  key: string;
  handle: OpencodeServerHandle;
}

export class OpencodeServerRegistry {
  private readonly servers = new Map<string, LiveEntry>();
  private adoptScanDone = false;

  constructor(private readonly deps: OpencodeServerRegistryDeps) {}

  size(): number {
    return this.servers.size;
  }

  refcount(key: string): number {
    return this.servers.get(key)?.refcount ?? 0;
  }

  async acquire(opts: {
    meetingId: string;
    cwd: string;
    spawn: () => Promise<OpencodeServerHandle>;
  }): Promise<AcquiredServer> {
    const key = serverKeyOf(opts.meetingId, opts.cwd);
    const existing = this.servers.get(key);
    if (existing) {
      existing.refcount += 1;
      this.persist();
      return { key, handle: existing.handle };
    }

    // First acquire in this process: sweep or adopt orphans from prior runs.
    if (!this.adoptScanDone) {
      this.adoptScanDone = true;
      const adopted = await this.adoptOrKillOrphans(opts.cwd);
      if (adopted) {
        const entry: LiveEntry = {
          key,
          meetingId: opts.meetingId,
          cwd: opts.cwd,
          handle: adopted,
          refcount: 1,
          startedAt: (this.deps.now ?? Date.now)(),
        };
        this.servers.set(key, entry);
        this.persist();
        return { key, handle: adopted };
      }
    }

    const handle = await opts.spawn();
    const entry: LiveEntry = {
      key,
      meetingId: opts.meetingId,
      cwd: opts.cwd,
      handle,
      refcount: 1,
      startedAt: (this.deps.now ?? Date.now)(),
    };
    this.servers.set(key, entry);
    handle.onExit(() => {
      // Server died on its own — drop it so the next acquire respawns.
      this.servers.delete(key);
      this.persist();
    });
    this.persist();
    return { key, handle };
  }

  /** Orphan sweep for one cwd: probe each persisted record, adopt the first
   *  live one, SIGTERM the rest (dead or duplicate). Returns the adopted
   *  handle (with a best-effort kill) or null. */
  private async adoptOrKillOrphans(cwd: string): Promise<OpencodeServerHandle | null> {
    let adopted: OpencodeServerHandle | null = null;
    for (const rec of this.deps.load()) {
      if (rec.cwd !== cwd) continue;
      const alive = await this.deps.probe(rec.url, rec.password).catch(() => false);
      if (alive && !adopted) {
        adopted = {
          url: rec.url,
          password: rec.password,
          pid: rec.pid,
          kill: () => {
            if (rec.pid) {
              try {
                process.kill(rec.pid, 'SIGTERM');
              } catch { /* already gone */ }
            }
          },
          // Not our child process — no exit events to relay.
          onExit: () => undefined,
        };
      } else if (rec.pid) {
        try {
          process.kill(rec.pid, 'SIGTERM');
        } catch { /* already gone */ }
      }
    }
    return adopted;
  }

  async release(key: string): Promise<void> {
    const entry = this.servers.get(key);
    if (!entry) return;
    entry.refcount -= 1;
    if (entry.refcount <= 0) {
      await this.kill(key);
    } else {
      this.persist();
    }
  }

  async kill(key: string): Promise<void> {
    const entry = this.servers.get(key);
    if (!entry) return;
    this.servers.delete(key);
    entry.handle.kill();
    this.persist();
  }

  async killAll(): Promise<void> {
    for (const key of [...this.servers.keys()]) {
      await this.kill(key);
    }
  }

  /** Table-driven lifecycle dispatch (SERVER_LIFECYCLE_MATRIX). */
  async handleLifecycle(event: ServerLifecycleEvent, key?: string): Promise<void> {
    const action = SERVER_LIFECYCLE_MATRIX[event];
    if (action === 'keep') return;
    if (action === 'kill-all') {
      await this.killAll();
      return;
    }
    if (!key) return;
    if (action === 'release') await this.release(key);
    else if (action === 'kill') await this.kill(key);
  }

  private persist(): void {
    const records: PersistedServerRecord[] = [...this.servers.values()].map((e) => ({
      meetingId: e.meetingId,
      cwd: e.cwd,
      pid: e.handle.pid,
      url: e.handle.url,
      password: e.handle.password,
      startedAt: e.startedAt,
    }));
    try {
      this.deps.save(records);
    } catch (err) {
      console.warn('[opencode-server-registry] persist failed:', err);
    }
  }
}

// ── Singleton with real deps (probe via /global/health, userData JSON) ─────

let singleton: OpencodeServerRegistry | null = null;

function recordsPath(): string {
  return join(app.getPath('userData'), 'opencode-servers.json');
}

function loadRecords(): PersistedServerRecord[] {
  try {
    const raw = readFileSync(recordsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecords(records: PersistedServerRecord[]): void {
  const path = recordsPath();
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic-ish write: tmp + rename, so a crash mid-write can't corrupt the
  // file the next adopt-or-kill scan reads.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function getOpencodeServerRegistry(): OpencodeServerRegistry {
  if (!singleton) {
    singleton = new OpencodeServerRegistry({
      probe: async (url, password) => {
        try {
          const res = await fetch(`${url}/global/health`, {
            headers: { authorization: basicAuthHeader(password) },
          });
          return res.ok;
        } catch {
          return false;
        }
      },
      load: loadRecords,
      save: saveRecords,
    });
  }
  return singleton;
}

/** Default spawn factory — pinned server config, explicit providerEnv. */
export function defaultServerSpawn(opts: {
  cwd: string;
  config: Record<string, unknown>;
  providerEnv?: NodeJS.ProcessEnv;
}): Promise<OpencodeServerHandle> {
  return spawnOpencodeServer({
    cwd: opts.cwd,
    config: opts.config,
    providerEnv: opts.providerEnv,
  });
}
