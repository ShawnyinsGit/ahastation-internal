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
import { inferClaudeState, inferCodexState, type PidState } from './state-machine.js';
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
    signal.clientKind === 'codex'
      ? [{ text: signal.title, source: 'session-index' }]
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
  return signal.tailSignals.turnCount + (signal.tailSignals.generating ? 1 : 0);
}

function correlateOne(input: CorrelateInput, signal: ObservedFileSignal): ObservedSession | null {
  const evidence: string[] = [`file:${signal.filePath}`];
  try {
    if (input.suppressedPaths.has(signal.filePath)) return null;
    if (input.selfSessionIds.has(signal.nativeSessionId)) return null;

    const realCwd = input.realpathOf(signal.cwd);
    const association = input.associations.get(
      associationKey(signal.clientKind, signal.nativeSessionId),
    );
    let pidState: PidState = 'none';
    let descendantCpuMax = 0;
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

    const inferred =
      signal.tailSignals.kind === 'claude'
        ? inferClaudeState({ tail: signal.tailSignals, descendantCpuMax, pidState })
        : inferCodexState({
            tail: signal.tailSignals,
            descendantCpuMax,
            pidState,
            mtimeMs: signal.mtimeMs,
            now: input.now,
          });
    if (!inferred) return null; // Claude: dead pid → session disappears
    evidence.push(`state:${inferred.state}/${inferred.activity} (inferred)`);

    const projectName = projectNameOf(signal.cwd);
    const { title, source } = pickTitle(signal, projectName);
    const isNoise =
      NOISE_PATH_PREFIXES.some((prefix) => realCwd.startsWith(prefix)) ||
      // Fresh live sessions legitimately have <2 messages — only fold short
      // sessions when nothing is running (stale evidence).
      (messageCount(signal) < 2 && pidState !== 'live');

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
      lastActiveAt: signal.mtimeMs,
      pid: association?.pid,
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
