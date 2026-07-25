// correlate.ts — merge process + file signals into ObservedSession rows.
//
// One row per (clientKind, nativeSessionId): identity hashes from the
// realpath'ed cwd (matching the orchestration project grouping), title from
// the per-client fallback chain (session_index → first real prompt →
// summary → project+time; never a raw path), state from the three-signal
// state machine, noise flags for tmp/short sessions. Every row is built
// inside its own try/catch: a broken signal degrades to state 'unknown',
// it never throws.

import type {
  ObservedFileSignal,
  ObservedSession,
  ObservedTitleSource,
} from './types.js';
import type { Association } from './mapping.js';
import { associationKey } from './mapping.js';
import { maxDescendantCpu, type ProcessSnapshot } from './process/darwin.js';
import {
  inferClaudeState,
  inferCodexDesktopState,
  inferCodexState,
  inferKimiState,
  type InferredState,
  type PidState,
} from './state-machine.js';
import { sanitizeTitle, sha1 } from './util.js';

export interface CorrelateInput {
  signals: ObservedFileSignal[];
  /** nativeSessionId → association (from mapping.associate). */
  associations: Map<string, Association>;
  snapshot: ProcessSnapshot;
  realpathOf: (path: string) => string;
  now: number;
  selfSessionIds: Set<string>;
  /** Rollout paths held open by mcp-server processes (ghost suppression). */
  suppressedPaths: Set<string>;
  /** Live Codex Desktop host (`codex app-server`) pid, self-exclusion already
   * applied. Shared by every codex-desktop thread row; undefined = no host. */
  codexDesktopHostPid?: number;
}

const NOISE_PATH_PREFIXES = ['/var/folders/', '/private/var/folders/', '/tmp/', '/private/tmp/'];

function projectNameOf(cwd: string): string {
  const segments = cwd.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : 'unknown-project';
}

function fallbackTitle(projectName: string, mtimeMs: number): string {
  const date = new Date(mtimeMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${projectName} · ${hh}:${mm}`;
}

interface TitlePick {
  title: string;
  source: ObservedTitleSource;
}

function looksLikePath(text: string): boolean {
  return /^[/~]/.test(text) || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('file://');
}

function pickTitle(signal: ObservedFileSignal, projectName: string): TitlePick {
  const candidates: Array<{ text?: string; source: ObservedTitleSource }> =
    signal.clientKind === 'codex' || signal.clientKind === 'kimi'
      ? [{ text: signal.title, source: signal.titleSource ?? 'session-index' }]
      : signal.tailSignals.kind === 'claude'
        ? [
            { text: signal.tailSignals.firstPromptTitle, source: 'first-prompt' },
            { text: signal.tailSignals.summaryTitle, source: 'summary' },
          ]
        : [];
  for (const candidate of candidates) {
    if (!candidate.text) continue;
    const sanitized = sanitizeTitle(candidate.text);
    // A pasted absolute path is not a title — fall through to project+time.
    if (sanitized && !looksLikePath(sanitized)) return { title: sanitized, source: candidate.source };
  }
  return { title: fallbackTitle(projectName, signal.mtimeMs), source: 'project-fallback' };
}

function messageCount(signal: ObservedFileSignal): number {
  if (signal.tailSignals.kind === 'claude') return signal.tailSignals.messagesSeen;
  if (signal.tailSignals.kind === 'kimi') return signal.tailSignals.messagesSeen;
  if (signal.tailSignals.kind === 'codex-desktop' || signal.tailSignals.kind === 'codex-merged') {
    // Desktop threads have no message content on disk; exempt from the
    // short-session noise fold — process/host liveness decides visibility.
    return 2;
  }
  return signal.tailSignals.turnCount + (signal.tailSignals.generating ? 1 : 0);
}

function correlateOne(input: CorrelateInput, signal: ObservedFileSignal): ObservedSession | null {
  const evidence: string[] = [`file:${signal.filePath}`];
  try {
    if (input.suppressedPaths.has(signal.filePath)) return null;
    if (input.selfSessionIds.has(signal.nativeSessionId)) return null;

    const realCwd = input.realpathOf(signal.cwd);
    let inferred: InferredState | null;
    let sessionPid: number | undefined;
    let pidState: PidState = 'none';
    let lastActiveAt = signal.mtimeMs;
    let descendantCpuMax = 0;
    /** Merged collision rows override the title pick with the live side's
     * display fields (recency tie-break when nothing is live). */
    let titleSignal = signal;

    if (signal.tailSignals.kind === 'codex-merged') {
      // CLI↔desktop collision row: both sides' evidence, and the live side's
      // rules decide state — desktop rules when a chat/host pid is live, CLI
      // rules when only the CLI pid is live, the CLI-side stale outcome
      // (idle pidless → board-hidden) when nothing is live.
      const tail = signal.tailSignals;
      // MCP ghost suppression keys on the per-thread rollout path.
      if (input.suppressedPaths.has(tail.cli.filePath)) return null;
      if (tail.desktop.filePath !== signal.filePath) {
        evidence.push(`file:${tail.desktop.filePath}`);
      }
      const liveChatPids = tail.desktop.chatPids.filter((chatPid) => input.snapshot.byPid.has(chatPid));
      for (const chatPid of liveChatPids) evidence.push(`chat-process pid ${chatPid} alive`);
      const hostPid = input.codexDesktopHostPid;
      const hostAlive = hostPid !== undefined;
      evidence.push(hostAlive
        ? `desktop-host:app-server pid ${hostPid}`
        : 'desktop-host:app-server not running');
      if (tail.desktop.unread) evidence.push('badge:unread');
      if (tail.desktop.heartbeat) evidence.push('badge:heartbeat-perms');

      const association = input.associations.get(
        associationKey(signal.clientKind, signal.nativeSessionId),
      );
      const cliAlive = association !== undefined && input.snapshot.byPid.has(association.pid);
      if (association) {
        if (cliAlive) {
          descendantCpuMax = maxDescendantCpu(input.snapshot, association.pid);
          evidence.push(`pid:${association.pid} via ${association.via}`);
          if (descendantCpuMax > 0) evidence.push(`descendant-cpu:${descendantCpuMax.toFixed(1)}%`);
        } else {
          evidence.push(`pid:${association.pid} dead`);
        }
      } else {
        evidence.push('no live process');
      }

      const desktopLive = liveChatPids.length > 0 || hostAlive;
      if (desktopLive) {
        inferred = inferCodexDesktopState({ liveChatPids, hostAlive });
      } else {
        pidState = association ? (cliAlive ? 'live' : 'dead') : 'none';
        inferred = inferCodexState({
          tail: tail.cli,
          descendantCpuMax,
          pidState,
          mtimeMs: tail.cli.mtimeMs,
          now: input.now,
        });
      }
      // Ownership: a live chat process owns the row, then the shared host
      // (host-backed idle), then a live CLI pid.
      sessionPid = liveChatPids[0] ?? hostPid ?? (cliAlive ? association?.pid : undefined);
      lastActiveAt = Math.max(tail.cli.mtimeMs, tail.desktop.mtimeMs, tail.desktop.lastChatUpdateAtMs);

      // Display fields: the live side's title wins; when nothing is live
      // the fresher side's (the old winner-take-all recency rule, demoted
      // to tie-breaker — desktop recency is chat-process updates only).
      const preferDesktop = desktopLive
        || (!cliAlive && tail.desktop.lastChatUpdateAtMs > tail.cli.mtimeMs);
      const preferred = preferDesktop ? tail.desktop : tail.cli;
      const fallback = preferDesktop ? tail.cli : tail.desktop;
      const pickedTitle = preferred.title ?? fallback.title;
      titleSignal = {
        ...signal,
        title: pickedTitle,
        titleSource: pickedTitle
          ? (preferred.title ? preferred.titleSource : fallback.titleSource)
          : undefined,
      };
    } else if (signal.tailSignals.kind === 'codex-desktop') {
      // Codex Desktop thread: no rollout tail and no PID association —
      // state comes from chat-process liveness plus the shared
      // app-server host detected by the service.
      const tail = signal.tailSignals;
      const liveChatPids = tail.chatPids.filter((chatPid) => input.snapshot.byPid.has(chatPid));
      for (const chatPid of liveChatPids) evidence.push(`chat-process pid ${chatPid} alive`);
      const hostPid = input.codexDesktopHostPid;
      evidence.push(hostPid !== undefined
        ? `desktop-host:app-server pid ${hostPid}`
        : 'desktop-host:app-server not running');
      if (tail.unread) evidence.push('badge:unread');
      if (tail.heartbeat) evidence.push('badge:heartbeat-perms');
      inferred = inferCodexDesktopState({ liveChatPids, hostAlive: hostPid !== undefined });
      // A live chat process owns the row; otherwise the host pid marks a
      // host-backed idle ("window open, nothing running").
      sessionPid = liveChatPids[0] ?? hostPid;
      lastActiveAt = Math.max(signal.mtimeMs, tail.lastChatUpdateAtMs);
    } else {
      const association = input.associations.get(
        associationKey(signal.clientKind, signal.nativeSessionId),
      );
      if (association) {
        const alive = input.snapshot.byPid.has(association.pid);
        pidState = alive ? 'live' : 'dead';
        if (alive) {
          descendantCpuMax = maxDescendantCpu(input.snapshot, association.pid);
          evidence.push(`pid:${association.pid} via ${association.via}`);
          if (descendantCpuMax > 0) evidence.push(`descendant-cpu:${descendantCpuMax.toFixed(1)}%`);
        } else {
          evidence.push(`pid:${association.pid} dead`);
        }
      } else {
        evidence.push('no live process');
      }

      inferred =
        signal.tailSignals.kind === 'claude'
          ? inferClaudeState({ tail: signal.tailSignals, descendantCpuMax, pidState })
          : signal.tailSignals.kind === 'kimi'
            ? inferKimiState({ tail: signal.tailSignals, descendantCpuMax, pidState })
            : inferCodexState({
                tail: signal.tailSignals,
                descendantCpuMax,
                pidState,
                mtimeMs: signal.mtimeMs,
                now: input.now,
              });
      sessionPid = association?.pid;
    }
    if (!inferred) return null; // Claude/Kimi: dead pid → session disappears
    evidence.push(`state:${inferred.state}/${inferred.activity} (inferred)`);

    const projectName = projectNameOf(signal.cwd);
    const { title, source } = pickTitle(titleSignal, projectName);
    const isNoise =
      NOISE_PATH_PREFIXES.some((prefix) => realCwd.startsWith(prefix)) ||
      // Fresh live sessions legitimately have <2 messages — only fold short
      // sessions when nothing is running (stale evidence).
      (messageCount(signal) < 2 && pidState !== 'live') ||
      // Untitled desktop threads with nothing running are low-information
      // rows (project+time fallback titles) — fold them into the noise
      // group; a live chat process or a curated title keeps them visible.
      // Merged collision rows follow the same rule on their picked title.
      (((signal.tailSignals.kind === 'codex-desktop' && !signal.title)
        || (signal.tailSignals.kind === 'codex-merged' && source === 'project-fallback'))
        && inferred.state !== 'active');

    return {
      id: sha1(`${signal.clientKind}:${signal.nativeSessionId}:${realCwd}`),
      clientKind: signal.clientKind,
      nativeSessionId: signal.nativeSessionId,
      projectId: sha1(realCwd),
      projectName,
      cwd: signal.cwd,
      title,
      state: inferred.state,
      activity: inferred.activity,
      inferred: true,
      model: signal.model,
      lastActiveAt,
      pid: sessionPid,
      titleSource: source,
      isNoise,
      evidence,
    };
  } catch (error) {
    // Unknown-state degradation: keep the row, mark it, never throw.
    const projectName = projectNameOf(signal.cwd);
    evidence.push(`correlate-error:${error instanceof Error ? error.message : String(error)}`);
    return {
      id: sha1(`${signal.clientKind}:${signal.nativeSessionId}:${signal.cwd}`),
      clientKind: signal.clientKind,
      nativeSessionId: signal.nativeSessionId,
      projectId: sha1(signal.cwd),
      projectName,
      cwd: signal.cwd,
      title: sanitizeTitle(signal.title ?? '') || fallbackTitle(projectName, signal.mtimeMs),
      state: 'unknown',
      activity: 'unknown',
      inferred: true,
      model: signal.model,
      lastActiveAt: signal.mtimeMs,
      pid: undefined,
      titleSource: signal.title ? 'session-index' : 'project-fallback',
      isNoise: true,
      evidence,
    };
  }
}

/** Merge all file signals (both clients) with process associations into the
 * published session list. */
export function correlate(input: CorrelateInput): ObservedSession[] {
  const sessions: ObservedSession[] = [];
  for (const signal of input.signals) {
    const session = correlateOne(input, signal);
    if (session) sessions.push(session);
  }
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return sessions;
}
