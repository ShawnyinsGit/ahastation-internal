// statefiles/codex-sessions.ts — read-only scan of Codex CLI rollouts.
//
// Data source: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Only the
// FIRST line is read for identity (session_meta: id/cwd/timestamp); the
// state machine runs over a bounded tail window. Titles come from
// ~/.codex/session_index.jsonl ({id, thread_name, updated_at} — latest
// updated_at wins, both ISO strings and epoch numbers tolerated).
//
// exec-session heuristic: session_meta.payload.source === 'exec' marks a
// one-shot `codex exec` run. Interactive sessions emit task_complete every
// turn, so only exec sessions may treat it as Done. If the source field is
// absent/unknown the session is treated as interactive (safe default).

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CodexTailSignals, ObservedFileSignal } from '../types.js';
import {
  HEAD_WINDOW_BYTES,
  TAIL_WINDOW_BYTES,
  asRecord,
  asString,
  lstatSafe,
  parseJsonLine,
  readWindowLines,
} from '../util.js';
import type { StateFileRef } from './claude-projects.js';

const SCAN_FILE_CAP = 50;
const SESSION_INDEX_MAX_BYTES = 8 * 1024 * 1024;

/** Newest-first rollout files under ~/.codex/sessions (YYYY/MM/DD nesting,
 * bounded depth), symlink fail-closed, capped. */
export async function listCodexRollouts(
  homeDir: string,
  cap = SCAN_FILE_CAP,
): Promise<StateFileRef[]> {
  const root = join(homeDir, '.codex', 'sessions');
  const refs: StateFileRef[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      const stat = await lstatSafe(entryPath);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(entryPath, depth + 1);
      } else if (stat.isFile() && entry.endsWith('.jsonl')) {
        refs.push({ filePath: entryPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
      }
    }
  };
  await walk(root, 0);
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return refs.slice(0, cap);
}

// ---------------------------------------------------------------------------
// session_index.jsonl → id → latest thread_name
// ---------------------------------------------------------------------------

function parseIndexTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Tolerate seconds vs milliseconds epochs.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** Load id → thread_name from ~/.codex/session_index.jsonl. Missing or
 * corrupt entries degrade to an empty/partial map. */
export async function loadCodexSessionIndex(homeDir: string): Promise<Map<string, string>> {
  const indexPath = join(homeDir, '.codex', 'session_index.jsonl');
  const stat = await lstatSafe(indexPath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return new Map();
  // The index is append-only; the tail holds the newest names when the file
  // grows past the read cap.
  const windowBytes = Math.min(SESSION_INDEX_MAX_BYTES, stat.size);
  const { lines } = await readWindowLines(indexPath, 'tail', windowBytes);
  const latest = new Map<string, { title: string; updatedAtMs: number }>();
  for (const raw of lines) {
    const parsed = asRecord(parseJsonLine(raw));
    if (!parsed) continue;
    const id = asString(parsed.id);
    const title = asString(parsed.thread_name);
    if (!id || !title) continue;
    const updatedAtMs = parseIndexTimestamp(parsed.updated_at);
    const existing = latest.get(id);
    if (!existing || updatedAtMs >= existing.updatedAtMs) {
      latest.set(id, { title, updatedAtMs });
    }
  }
  return new Map(Array.from(latest.entries()).map(([id, entry]) => [id, entry.title]));
}

// ---------------------------------------------------------------------------
// First line: session_meta
// ---------------------------------------------------------------------------

interface CodexMeta {
  sessionId?: string;
  cwd?: string;
  startedAtMs?: number;
  isExec: boolean;
  model?: string;
}

/** Read only the first line for session_meta. The rollout filename embeds
 * the session UUID (`rollout-<ts>-<uuid>.jsonl`) as a fallback identity. */
export async function readCodexMeta(filePath: string): Promise<CodexMeta> {
  const meta: CodexMeta = { isExec: false };
  try {
    const head = await readWindowLines(filePath, 'head', HEAD_WINDOW_BYTES);
    const firstLine = head.lines.find((line) => line.trim());
    const parsed = asRecord(parseJsonLine(firstLine ?? ''));
    if (parsed && parsed.type === 'session_meta') {
      const payload = asRecord(parsed.payload);
      if (payload) {
        meta.sessionId = asString(payload.id) ?? asString(payload.session_id);
        meta.cwd = asString(payload.cwd);
        const ts = asString(payload.timestamp);
        if (ts) {
          const parsedTs = Date.parse(ts);
          if (!Number.isNaN(parsedTs)) meta.startedAtMs = parsedTs;
        }
        // Best-effort exec detection (see header note).
        meta.isExec = asString(payload.source) === 'exec';
        meta.model = asString(payload.model);
      }
    }
  } catch {
    // Fall through to the filename-based identity below.
  }
  if (!meta.sessionId) {
    const match = /rollout-[^/]*-([0-9a-fA-F-]{32,36})\.jsonl$/.exec(filePath);
    if (match) meta.sessionId = match[1];
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Tail window: event state machine inputs
// ---------------------------------------------------------------------------

/** Walk the rollout tail (oldest → newest): user_message sets generating,
 * agent_message/task_complete clear it, function_call/_output pair by
 * call_id. custom_tool_call pairs are tracked the same way. */
export function analyzeCodexTail(lines: string[]): CodexTailSignals {
  const openCalls = new Set<string>();
  let generating = false;
  let sawTaskComplete = false;
  let turnCount = 0;
  for (const raw of lines) {
    const parsed = asRecord(parseJsonLine(raw));
    if (!parsed) continue;
    const payload = asRecord(parsed.payload);
    if (!payload) continue;
    if (parsed.type === 'event_msg') {
      if (payload.type === 'user_message') {
        generating = true;
      } else if (payload.type === 'agent_message') {
        generating = false;
        turnCount += 1;
      } else if (payload.type === 'task_complete') {
        generating = false;
        sawTaskComplete = true;
      }
    } else if (parsed.type === 'response_item') {
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const callId = asString(payload.call_id);
        if (callId) openCalls.add(callId);
        generating = false;
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const callId = asString(payload.call_id);
        if (callId) openCalls.delete(callId);
      }
    }
  }
  return {
    kind: 'codex',
    generating,
    pendingFunctionCalls: openCalls.size,
    sawTaskComplete,
    isExec: false, // filled in by the caller from session_meta
    turnCount,
  };
}

/** Parse one rollout into a file signal; null when no identity is found.
 * `indexTitles` is the session_index map (id → thread_name). */
export async function parseCodexRollout(
  ref: StateFileRef,
  indexTitles: Map<string, string>,
): Promise<ObservedFileSignal | null> {
  try {
    const meta = await readCodexMeta(ref.filePath);
    if (!meta.sessionId || !meta.cwd) return null;
    const tail = await readWindowLines(ref.filePath, 'tail', TAIL_WINDOW_BYTES);
    const tailSignals = analyzeCodexTail(tail.lines);
    tailSignals.isExec = meta.isExec;
    return {
      clientKind: 'codex',
      nativeSessionId: meta.sessionId,
      cwd: meta.cwd,
      filePath: ref.filePath,
      mtimeMs: ref.mtimeMs,
      sizeBytes: ref.sizeBytes,
      title: indexTitles.get(meta.sessionId),
      model: meta.model,
      tailSignals,
    };
  } catch {
    return null;
  }
}

export const CODEX_LIMITS = { SCAN_FILE_CAP, SESSION_INDEX_MAX_BYTES } as const;
