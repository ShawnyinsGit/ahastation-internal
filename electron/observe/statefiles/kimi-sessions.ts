// statefiles/kimi-sessions.ts — read-only scan of Kimi Code CLI sessions.
//
// Data source: ~/.kimi-code/session_index.jsonl ({sessionId, sessionDir,
// workDir} per line, newest at tail) → <sessionDir>/state.json (identity,
// title, workDir, updatedAt; single JSON object) and
// <sessionDir>/logs/kimi-code.log (text log; a trailing `llm request`
// with no later `llm response` means a generation is in flight).
//
// Safety: sessionDir values come from the index file, so they are only
// honored inside ~/.kimi-code/sessions/ (containment check). state.json is
// read with a 1MB cap, the log with the shared 64KB tail window. Symlinks
// fail closed: a symlinked/missing state.json skips the session; a
// symlinked/missing log degrades to zero tail signals (the session still
// parses — fresh sessions may not have a logs/ dir yet).
//
// Kimi processes carry no session id in their args, so PID association is
// cwd-only (mapping.ts fallback 3a). Refs are sorted by state.json mtime
// (fs-level proxy for its updatedAt) so the newest session in a shared
// workDir wins the association.

import { join, sep } from 'node:path';
import type {
  KimiTailSignals,
  ObservedFileSignal,
  ObservedTitleSource,
} from '../types.js';
import {
  TAIL_WINDOW_BYTES,
  asRecord,
  asString,
  lstatSafe,
  parseJsonLine,
  readWindowLines,
} from '../util.js';
import type { StateFileRef } from './claude-projects.js';

const SCAN_SESSION_CAP = 50;
const SESSION_INDEX_MAX_BYTES = 8 * 1024 * 1024;
const STATE_JSON_MAX_BYTES = 1024 * 1024;

export interface KimiSessionRef extends StateFileRef {
  sessionId: string;
  sessionDir: string;
  logPath: string;
  /** state.json fs mtime — sort key, proxies its updatedAt field. */
  stateMtimeMs: number;
  indexWorkDir?: string;
}

interface KimiIndexEntry {
  sessionId: string;
  sessionDir: string;
  workDir?: string;
}

// ---------------------------------------------------------------------------
// session_index.jsonl → newest-first session entries
// ---------------------------------------------------------------------------

/** Read the tail window of ~/.kimi-code/session_index.jsonl. Newest lines
 * sit at the tail; duplicates collapse to their latest position. Corrupt
 * lines, entries without sessionId/sessionDir, and sessionDirs outside
 * ~/.kimi-code/sessions/ are skipped. Capped at the newest 50. */
export async function loadKimiSessionIndex(homeDir: string): Promise<KimiIndexEntry[]> {
  const indexPath = join(homeDir, '.kimi-code', 'session_index.jsonl');
  const stat = await lstatSafe(indexPath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return [];
  const windowBytes = Math.min(SESSION_INDEX_MAX_BYTES, stat.size);
  const { lines } = await readWindowLines(indexPath, 'tail', windowBytes);
  const sessionsRoot = join(homeDir, '.kimi-code', 'sessions');
  const byId = new Map<string, KimiIndexEntry>();
  for (const raw of lines) {
    const parsed = asRecord(parseJsonLine(raw));
    if (!parsed) continue;
    const sessionId = asString(parsed.sessionId);
    const sessionDir = asString(parsed.sessionDir);
    if (!sessionId || !sessionDir) continue;
    // Containment: the index is external input; never read state files
    // outside ~/.kimi-code/sessions/.
    if (!sessionDir.startsWith(sessionsRoot + sep)) continue;
    // delete+set re-inserts at the tail: the newest occurrence wins.
    byId.delete(sessionId);
    byId.set(sessionId, { sessionId, sessionDir, workDir: asString(parsed.workDir) });
  }
  return Array.from(byId.values()).slice(-SCAN_SESSION_CAP);
}

/** Resolve each index entry to its state.json + log file, newest
 * (state.json mtime) first. A missing/symlinked state.json skips the
 * session; the log is optional. ref.mtimeMs/sizeBytes combine BOTH files so
 * the caller's change marker re-parses when either moves — state.json
 * writes lag the log by minutes during active generation. */
export async function listKimiSessions(
  homeDir: string,
  cap = SCAN_SESSION_CAP,
): Promise<KimiSessionRef[]> {
  const entries = await loadKimiSessionIndex(homeDir);
  const refs: KimiSessionRef[] = [];
  for (const entry of entries.slice(-cap)) {
    const statePath = join(entry.sessionDir, 'state.json');
    const logPath = join(entry.sessionDir, 'logs', 'kimi-code.log');
    const stateStat = await lstatSafe(statePath);
    if (!stateStat || !stateStat.isFile() || stateStat.isSymbolicLink()) continue;
    const logStat = await lstatSafe(logPath);
    const logOk = logStat && logStat.isFile() && !logStat.isSymbolicLink() ? logStat : null;
    refs.push({
      filePath: statePath,
      mtimeMs: Math.max(stateStat.mtimeMs, logOk?.mtimeMs ?? 0),
      sizeBytes: stateStat.size + (logOk?.size ?? 0),
      sessionId: entry.sessionId,
      sessionDir: entry.sessionDir,
      logPath,
      stateMtimeMs: stateStat.mtimeMs,
      indexWorkDir: entry.workDir,
    });
  }
  refs.sort((a, b) => b.stateMtimeMs - a.stateMtimeMs);
  return refs;
}

// ---------------------------------------------------------------------------
// state.json: identity + title candidates
// ---------------------------------------------------------------------------

interface KimiStateInfo {
  title?: string;
  lastPrompt?: string;
  workDir?: string;
  updatedAtMs: number;
}

/** Tolerant parse of the (capped) state.json text; null when unreadable. */
export function parseKimiStateJson(text: string): KimiStateInfo | null {
  const parsed = asRecord(parseJsonLine(text));
  if (!parsed) return null;
  const updatedAt = asString(parsed.updatedAt);
  const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return {
    title: asString(parsed.title),
    lastPrompt: asString(parsed.lastPrompt),
    workDir: asString(parsed.workDir),
    updatedAtMs: Number.isNaN(updatedAtMs) ? 0 : updatedAtMs,
  };
}

// ---------------------------------------------------------------------------
// kimi-code.log tail: in-flight detection + rough turn count
// ---------------------------------------------------------------------------

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/;

/** Walk the log tail (oldest → newest): a trailing `llm request` with no
 * later `llm response` means generation in flight. `llm response` lines
 * double as a rough turn count; the max leading ISO timestamp is the last
 * event time. Non-log lines tolerate silently. */
export function analyzeKimiLogTail(lines: string[]): KimiTailSignals {
  let lastRequest = -1;
  let lastResponse = -1;
  let lastEventAtMs = 0;
  let messagesSeen = 0;
  lines.forEach((line, index) => {
    if (line.includes('llm request')) {
      lastRequest = index;
    } else if (line.includes('llm response')) {
      lastResponse = index;
      messagesSeen += 1;
    }
    const match = LOG_TIMESTAMP.exec(line);
    if (match) {
      const ms = Date.parse(match[1]);
      if (!Number.isNaN(ms) && ms > lastEventAtMs) lastEventAtMs = ms;
    }
  });
  return {
    kind: 'kimi',
    inFlightRequest: lastRequest > lastResponse,
    lastEventAtMs,
    messagesSeen,
  };
}

// ---------------------------------------------------------------------------
// Session → signal
// ---------------------------------------------------------------------------

/** Parse one session into a file signal. Returns null when state.json has
 * no extractable identity (workDir) — corrupt files degrade, never throw.
 * Title: state.json title (session-index), else lastPrompt truncated to 60
 * chars (first-prompt), else undefined → the downstream fallback chain. */
export async function parseKimiSession(ref: KimiSessionRef): Promise<ObservedFileSignal | null> {
  try {
    const stateWindow = await readWindowLines(ref.filePath, 'head', STATE_JSON_MAX_BYTES);
    const state = parseKimiStateJson(stateWindow.lines.join('\n'));
    if (!state) return null;
    const workDir = state.workDir ?? ref.indexWorkDir;
    if (!workDir) return null;
    let title = state.title;
    let titleSource: ObservedTitleSource | undefined;
    if (title) {
      titleSource = 'session-index';
    } else if (state.lastPrompt) {
      title = state.lastPrompt.slice(0, 60);
      titleSource = 'first-prompt';
    }
    let tailSignals: KimiTailSignals = {
      kind: 'kimi',
      inFlightRequest: false,
      lastEventAtMs: 0,
      messagesSeen: 0,
    };
    try {
      const tail = await readWindowLines(ref.logPath, 'tail', TAIL_WINDOW_BYTES);
      tailSignals = analyzeKimiLogTail(tail.lines);
    } catch {
      // Missing/unreadable log → zero signals (fresh sessions have none).
    }
    return {
      clientKind: 'kimi',
      nativeSessionId: ref.sessionId,
      cwd: workDir,
      filePath: ref.filePath,
      mtimeMs: ref.mtimeMs,
      sizeBytes: ref.sizeBytes,
      title,
      titleSource,
      tailSignals,
    };
  } catch {
    return null;
  }
}

export const KIMI_LIMITS = { SCAN_SESSION_CAP, SESSION_INDEX_MAX_BYTES, STATE_JSON_MAX_BYTES } as const;
