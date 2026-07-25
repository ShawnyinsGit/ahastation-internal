// observe-service.ts — dual-tick scheduler for the observation layer.
//
// Fast tick (2s): shared ps snapshot + state inference + full-snapshot
// publish. Slow tick (10s): title sources (Codex session_index, Claude PID
// files). When no session is active the loop backs off to the slow cadence.
// State files carry mtime+size change markers so unchanged transcripts are
// never re-parsed (codedash change-marker polling; no fs.watch).
//
// The service is Electron-free: homeDir / publish / self-exclusion are
// injected, so `node --test` exercises it through dist-electron. Every
// observer scan and subprocess call is independently fault-isolated — one
// broken client can never kill a scan cycle.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { correlate } from './correlate.js';
import {
  associate,
  associationKey,
  detectMcpServerPids,
  loadClaudePidFiles,
  mcpHeldRolloutPaths,
  type Association,
  type ClaudePidFileEntry,
} from './mapping.js';
import {
  captureProcessSnapshot,
  findClientPids,
  lsofOpenFiles,
  type ProcessSnapshot,
} from './process/darwin.js';
import {
  listClaudeTranscripts,
  parseClaudeTranscript,
  type StateFileRef,
} from './statefiles/claude-projects.js';
import {
  listCodexRollouts,
  loadCodexTitles,
  parseCodexRollout,
} from './statefiles/codex-sessions.js';
import type {
  ClientKind,
  ObservedFileSignal,
  ObservedSession,
  ObservedSnapshot,
  ObservedTitleSource,
  SelfExclusion,
} from './types.js';
import { defaultExec, lstatSafe, type ExecImpl } from './util.js';

export interface ObserveServiceOptions {
  homeDir: string;
  publish: (snapshot: ObservedSnapshot) => void;
  /** App-spawned workers to hide: own process tree + own session ids. */
  getSelfExclusion?: () => SelfExclusion;
  fastMs?: number;
  slowMs?: number;
  now?: () => number;
  execImpl?: ExecImpl;
  /** Test seam: replace the live ps capture. */
  snapshotProvider?: () => Promise<ProcessSnapshot>;
  /** Test seam: replace fs.realpath. */
  realpathImpl?: (path: string) => Promise<string>;
}

interface FileMarker {
  mtimeMs: number;
  sizeBytes: number;
  signal: ObservedFileSignal | null;
}

const DEFAULT_FAST_MS = 2_000;
const DEFAULT_SLOW_MS = 10_000;

export class ObserveService {
  private readonly homeDir: string;
  private readonly publish: (snapshot: ObservedSnapshot) => void;
  private readonly getSelfExclusion: () => SelfExclusion;
  private readonly fastMs: number;
  private readonly slowMs: number;
  private readonly now: () => number;
  private readonly execImpl: ExecImpl;
  private readonly snapshotProvider: () => Promise<ProcessSnapshot>;
  private readonly realpathImpl: (path: string) => Promise<string>;

  private readonly claudeMarkers = new Map<string, FileMarker>();
  private readonly codexMarkers = new Map<string, FileMarker>();
  private readonly realpathCache = new Map<string, string>();
  private indexTitles = new Map<string, string>();
  private titleSources = new Map<string, 'global-state' | 'session-index'>();
  private indexMarker: string | null = null;
  private pidFileMap = new Map<number, ClaudePidFileEntry>();

  private running = false;
  private ticking = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSlowAt = Number.NEGATIVE_INFINITY;
  private lastSessions: ObservedSession[] = [];

  constructor(options: ObserveServiceOptions) {
    this.homeDir = options.homeDir;
    this.publish = options.publish;
    this.getSelfExclusion = options.getSelfExclusion
      ?? (() => ({ pids: new Set(), sessionIds: new Set() }));
    this.fastMs = options.fastMs ?? DEFAULT_FAST_MS;
    this.slowMs = options.slowMs ?? DEFAULT_SLOW_MS;
    this.now = options.now ?? Date.now;
    this.execImpl = options.execImpl ?? defaultExec;
    this.snapshotProvider = options.snapshotProvider
      ?? (() => captureProcessSnapshot(this.execImpl));
    this.realpathImpl = options.realpathImpl ?? ((path: string) => fs.realpath(path));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  get sessions(): ObservedSession[] {
    return this.lastSessions;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tickOnce();
      } catch {
        // A tick must never kill the loop; next cycle rescans everything.
      }
      if (!this.running) return;
      // Idle backoff: nothing active → drop to the slow cadence.
      const active = this.lastSessions.some((session) => session.state === 'active');
      const delay = active ? this.fastMs : Math.max(this.fastMs, this.slowMs);
      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, delay);
      });
    }
  }

  /** One full scan cycle. Public so tests and the smoke script can drive
   * the service without timers. */
  async tickOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const selfExclusion = this.getSelfExclusion();

      // Shared process snapshot; ps failure degrades to "no processes".
      let snapshot: ProcessSnapshot;
      try {
        snapshot = await this.snapshotProvider();
      } catch {
        snapshot = { byPid: new Map(), childrenOf: new Map(), capturedAt: now };
      }

      // Slow-tick refresh: title sources + PID files.
      if (now - this.lastSlowAt >= this.slowMs) {
        await this.refreshSlowInputs();
        this.lastSlowAt = now;
      }

      // Per-observer scans, independently fault-isolated.
      const claudeSignals = await this.scanObserver('claude-code');
      const codexSignals = await this.scanObserver('codex');
      const signals = [...claudeSignals, ...codexSignals];

      // Client processes (exclusion list already drops mcp-server & co).
      const claudePids = findClientPids(snapshot, ['claude']);
      const codexPids = findClientPids(snapshot, ['codex']);
      const mcpPids = detectMcpServerPids(snapshot);

      // One batched lsof for every pid we care about.
      const lsofPids = Array.from(new Set([...claudePids, ...codexPids, ...mcpPids]))
        .filter((pid) => !selfExclusion.pids.has(pid));
      const lsofByPid = await lsofOpenFiles(lsofPids, this.execImpl);
      const suppressedPaths = mcpHeldRolloutPaths(lsofByPid, mcpPids);

      const realpathOf = await this.buildRealpathResolver(signals, lsofByPid);

      // PID ↔ session association per client.
      const associations = new Map<string, Association>();
      const clients: Array<{ kind: ClientKind; pids: number[] }> = [
        { kind: 'claude-code', pids: claudePids },
        { kind: 'codex', pids: codexPids },
      ];
      for (const client of clients) {
        const clientSignals = signals.filter((signal) => signal.clientKind === client.kind);
        const clientAssociations = associate({
          clientKind: client.kind,
          pids: client.pids,
          signals: clientSignals,
          snapshot,
          lsofByPid,
          pidFileMap: client.kind === 'claude-code' ? this.pidFileMap : undefined,
          realpathOf,
          selfExclusion,
        });
        for (const [sessionId, association] of clientAssociations) {
          associations.set(associationKey(client.kind, sessionId), association);
        }
      }

      this.lastSessions = correlate({
        signals,
        associations,
        snapshot,
        realpathOf,
        now,
        selfSessionIds: selfExclusion.sessionIds,
        suppressedPaths,
      });
      this.publish({ sessions: this.lastSessions, scannedAt: this.now() });
    } finally {
      this.ticking = false;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async refreshSlowInputs(): Promise<void> {
    // Codex titles (session_index + global-state): reload when either changed.
    try {
      const indexPath = join(this.homeDir, '.codex', 'session_index.jsonl');
      const globalPath = join(this.homeDir, '.codex', '.codex-global-state.json');
      const [indexStat, globalStat] = await Promise.all([lstatSafe(indexPath), lstatSafe(globalPath)]);
      const markerOf = (stat: Awaited<ReturnType<typeof lstatSafe>>) =>
        stat && stat.isFile() && !stat.isSymbolicLink()
          ? `${stat.mtimeMs}:${stat.size}`
          : 'absent';
      const marker = `${markerOf(indexStat)}|${markerOf(globalStat)}`;
      if (this.indexMarker !== marker) {
        const { titles, sources } = await loadCodexTitles(this.homeDir);
        this.indexTitles = titles;
        this.titleSources = sources;
        this.indexMarker = marker;
      }
    } catch {
      this.indexTitles = new Map();
      this.titleSources = new Map();
    }
    // Claude PID files: tiny directory (absent on some versions — degrades).
    try {
      this.pidFileMap = await loadClaudePidFiles(this.homeDir);
    } catch {
      this.pidFileMap = new Map();
    }
  }

  private async scanObserver(kind: ClientKind): Promise<ObservedFileSignal[]> {
    try {
      const refs = kind === 'claude-code'
        ? await listClaudeTranscripts(this.homeDir)
        : await listCodexRollouts(this.homeDir);
      const markers = kind === 'claude-code' ? this.claudeMarkers : this.codexMarkers;
      const signals: ObservedFileSignal[] = [];
      for (const ref of refs) {
        const cached = markers.get(ref.filePath);
        if (cached && cached.mtimeMs === ref.mtimeMs && cached.sizeBytes === ref.sizeBytes) {
          // mtime+size change marker: unchanged file, reuse the parse.
          if (cached.signal) signals.push(this.withFreshTitle(cached.signal));
          continue;
        }
        const signal = await this.parseRef(kind, ref);
        markers.set(ref.filePath, { mtimeMs: ref.mtimeMs, sizeBytes: ref.sizeBytes, signal });
        if (signal) signals.push(signal);
      }
      // Evict markers for files that fell out of the scan window.
      const scanned = new Set(refs.map((ref) => ref.filePath));
      for (const key of Array.from(markers.keys())) {
        if (!scanned.has(key)) markers.delete(key);
      }
      return signals;
    } catch {
      return []; // per-observer isolation
    }
  }

  private async parseRef(kind: ClientKind, ref: StateFileRef): Promise<ObservedFileSignal | null> {
    return kind === 'claude-code'
      ? parseClaudeTranscript(ref)
      : parseCodexRollout(ref, this.indexTitles, this.titleSources);
  }

  /** Re-attach the latest Codex title to a cached signal. */
  private withFreshTitle(signal: ObservedFileSignal): ObservedFileSignal {
    if (signal.clientKind !== 'codex') return signal;
    const title = this.indexTitles.get(signal.nativeSessionId);
    if (!title || title === signal.title) return signal;
    return { ...signal, title, titleSource: this.titleSources.get(signal.nativeSessionId) };
  }

  private async buildRealpathResolver(
    signals: ObservedFileSignal[],
    lsofByPid: Map<number, { cwd?: string }>,
  ): Promise<(path: string) => string> {
    const paths = new Set<string>();
    for (const signal of signals) paths.add(signal.cwd);
    for (const entry of lsofByPid.values()) {
      if (entry.cwd) paths.add(entry.cwd);
    }
    for (const path of paths) {
      if (this.realpathCache.has(path)) continue;
      try {
        this.realpathCache.set(path, await this.realpathImpl(path));
      } catch {
        this.realpathCache.set(path, path); // unresolvable → use as-is
      }
    }
    return (path: string) => this.realpathCache.get(path) ?? path;
  }
}
