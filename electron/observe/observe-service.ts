// observe-service.ts — dual-tick scheduler for the observation layer.
//
// Fast tick (2s): shared ps snapshot + state inference + full-snapshot
// publish. Slow tick (10s): title sources (Codex session_index, Claude PID
// files). When no session is active the loop backs off to the slow cadence.
// Codex Desktop (ChatGPT.app code mode) threads are scanned alongside the
// three CLI observers: their state is pure process/host liveness, so their
// signals cache on the two state files' markers while liveness is
// re-evaluated from the fresh ps snapshot every tick.
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
  detectCodexDesktopHostPids,
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
  listCodexDesktopThreads,
  parseCodexDesktopThread,
} from './statefiles/codex-desktop.js';
import {
  listCodexRollouts,
  loadCodexTitles,
  parseCodexRollout,
} from './statefiles/codex-sessions.js';
import {
  listKimiSessions,
  parseKimiSession,
  type KimiSessionRef,
} from './statefiles/kimi-sessions.js';
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

/** mtime+size change marker for one file; 'absent' for missing/symlinked
 * (fail-closed — the symlink case is never read). */
function fileMarker(stat: Awaited<ReturnType<typeof lstatSafe>>): string {
  return stat && stat.isFile() && !stat.isSymbolicLink()
    ? `${stat.mtimeMs}:${stat.size}`
    : 'absent';
}

/** Merge CLI rollout signals with Codex Desktop thread signals, keeping one
 * row per thread id. The same id can exist in both worlds — the desktop app
 * resumes CLI sessions — and two rows would duplicate a board card (and its
 * React key). The fresher side wins: a live desktop turn must not hide
 * behind a stale CLI rollout, and a live `codex resume` must not hide
 * behind an old desktop thread. Desktop-side recency uses chat-process
 * updates only: the global-state mtime is app-wide, not per-thread. */
export function mergeCodexDesktopSignals(
  codexSignals: ObservedFileSignal[],
  desktopSignals: ObservedFileSignal[],
): ObservedFileSignal[] {
  const cliById = new Map(codexSignals.map((signal) => [signal.nativeSessionId, signal]));
  const desktopWins = new Set<string>();
  for (const signal of desktopSignals) {
    if (signal.tailSignals.kind !== 'codex-desktop') continue;
    const cli = cliById.get(signal.nativeSessionId);
    if (cli && signal.tailSignals.lastChatUpdateAtMs > cli.mtimeMs) {
      desktopWins.add(signal.nativeSessionId);
    }
  }
  return [
    ...codexSignals.filter((signal) => !desktopWins.has(signal.nativeSessionId)),
    ...desktopSignals.filter((signal) => {
      if (signal.tailSignals.kind !== 'codex-desktop') return true;
      return !cliById.has(signal.nativeSessionId) || desktopWins.has(signal.nativeSessionId);
    }),
  ];
}

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
  private readonly kimiMarkers = new Map<string, FileMarker>();
  private readonly realpathCache = new Map<string, string>();
  private indexTitles = new Map<string, string>();
  private titleSources = new Map<string, 'global-state' | 'session-index'>();
  private indexMarker: string | null = null;
  private pidFileMap = new Map<number, ClaudePidFileEntry>();
  private desktopMarker: string | null = null;
  private desktopSignalsCache: ObservedFileSignal[] = [];

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
      const kimiSignals = await this.scanObserver('kimi');
      const desktopSignals = await this.scanCodexDesktop();
      const signals = [
        ...claudeSignals,
        ...mergeCodexDesktopSignals(codexSignals, desktopSignals),
        ...kimiSignals,
      ];

      // Codex Desktop host (`codex app-server`): excluded from CLI
      // candidates by the app-server token exclusion; the app's own adapter
      // children are dropped by the self-exclusion pid tree.
      const codexDesktopHostPid = detectCodexDesktopHostPids(snapshot)
        .find((pid) => !selfExclusion.pids.has(pid));

      // Client processes (exclusion list already drops mcp-server & co).
      const claudePids = findClientPids(snapshot, ['claude']);
      const codexPids = findClientPids(snapshot, ['codex']);
      const kimiPids = findClientPids(snapshot, ['kimi-code']);
      const mcpPids = detectMcpServerPids(snapshot);

      // One batched lsof for every pid we care about.
      const lsofPids = Array.from(new Set([...claudePids, ...codexPids, ...kimiPids, ...mcpPids]))
        .filter((pid) => !selfExclusion.pids.has(pid));
      const lsofByPid = await lsofOpenFiles(lsofPids, this.execImpl);
      const suppressedPaths = mcpHeldRolloutPaths(lsofByPid, mcpPids);

      const realpathOf = await this.buildRealpathResolver(signals, lsofByPid);

      // PID ↔ session association per client.
      const associations = new Map<string, Association>();
      const clients: Array<{ kind: ClientKind; pids: number[] }> = [
        { kind: 'claude-code', pids: claudePids },
        { kind: 'codex', pids: codexPids },
        { kind: 'kimi', pids: kimiPids },
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
        codexDesktopHostPid,
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
      const marker = `${fileMarker(indexStat)}|${fileMarker(globalStat)}`;
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

  /** Codex Desktop threads (ChatGPT.app code mode): global-state
   * descriptions joined with chat-spawned processes. Cached on the two
   * source files' mtime+size markers — process liveness is evaluated
   * per-tick downstream in correlate, so a cached signal never goes stale. */
  private async scanCodexDesktop(): Promise<ObservedFileSignal[]> {
    try {
      const globalPath = join(this.homeDir, '.codex', '.codex-global-state.json');
      const procsPath = join(this.homeDir, '.codex', 'process_manager', 'chat_processes.json');
      const [globalStat, procsStat] = await Promise.all([lstatSafe(globalPath), lstatSafe(procsPath)]);
      const marker = `${fileMarker(globalStat)}|${fileMarker(procsStat)}`;
      if (marker === this.desktopMarker) return this.desktopSignalsCache;
      const threads = await listCodexDesktopThreads(this.homeDir);
      const signals: ObservedFileSignal[] = [];
      for (const thread of threads) {
        const signal = parseCodexDesktopThread(thread);
        if (signal) signals.push(signal);
      }
      this.desktopMarker = marker;
      this.desktopSignalsCache = signals;
      return signals;
    } catch {
      return []; // per-observer isolation
    }
  }

  private async scanObserver(kind: ClientKind): Promise<ObservedFileSignal[]> {
    try {
      const refs = kind === 'claude-code'
        ? await listClaudeTranscripts(this.homeDir)
        : kind === 'codex'
          ? await listCodexRollouts(this.homeDir)
          : await listKimiSessions(this.homeDir);
      const markers = kind === 'claude-code'
        ? this.claudeMarkers
        : kind === 'codex'
          ? this.codexMarkers
          : this.kimiMarkers;
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
    if (kind === 'claude-code') return parseClaudeTranscript(ref);
    if (kind === 'codex') return parseCodexRollout(ref, this.indexTitles, this.titleSources);
    return parseKimiSession(ref as KimiSessionRef);
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
