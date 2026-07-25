// statefiles/claude-projects.ts — read-only scan of Claude Code transcripts.
//
// Data source: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl (the only
// authoritative source in v1+; history.jsonl is legacy metadata). Line
// shape varies by client version — sessionId/cwd/gitBranch live on
// user/assistant/attachment lines, not on a fixed first line, so the head
// scan tolerates several leading non-message lines (queue-operation,
// last-prompt, mode, file-history-snapshot, ...).
//
// Title: first real user prompt (truncated by the caller's sanitize step)
// or a type:"summary" line; never a raw path.
//
// State tail (last ~64KB): synthetic-user filtering is mandatory — without
// it, idle sessions pin at Thinking forever (abtop lesson).

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeTailSignals, ObservedFileSignal } from '../types.js';
import {
  HEAD_WINDOW_BYTES,
  MAX_LINE_BYTES,
  TAIL_WINDOW_BYTES,
  asRecord,
  asString,
  lstatSafe,
  parseJsonLine,
  readWindowLines,
} from '../util.js';

const SCAN_FILE_CAP = 50;
const HEAD_LINE_CAP = 200;

export interface StateFileRef {
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** Newest-first list of transcript files under ~/.claude/projects, capped.
 * Missing root or unreadable entries degrade to an empty/partial list. */
export async function listClaudeTranscripts(
  homeDir: string,
  cap = SCAN_FILE_CAP,
): Promise<StateFileRef[]> {
  const root = join(homeDir, '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await fs.readdir(root);
  } catch {
    return [];
  }
  const refs: StateFileRef[] = [];
  for (const dir of projectDirs) {
    const dirPath = join(root, dir);
    const dirStat = await lstatSafe(dirPath);
    if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(dirPath, file);
      const stat = await lstatSafe(filePath);
      // Symlink fail-closed: lstat error or an actual link → skip.
      if (!stat || !stat.isFile() || stat.isSymbolicLink()) continue;
      refs.push({ filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
    }
  }
  refs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return refs.slice(0, cap);
}

// ---------------------------------------------------------------------------
// Synthetic user filtering (tool_result wrappers, meta lines, local-command
// echoes are not human input)
// ---------------------------------------------------------------------------

const SYNTHETIC_PREFIXES = [
  '<local-command-stdout>',
  '<command-name>',
  '<bash-input>',
  '<local-command-caveat>',
];

function contentBlocks(content: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(content) ? (content.filter(asRecord) as Array<Record<string, unknown>>) : null;
}

export function isSyntheticClaudeUserLine(line: Record<string, unknown>): boolean {
  if (line.isMeta === true) return true;
  const message = asRecord(line.message);
  const content = message?.content;
  if (typeof content === 'string') {
    const trimmed = content.trimStart();
    return SYNTHETIC_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  }
  const blocks = contentBlocks(content);
  if (blocks && blocks.length > 0 && blocks.every((block) => block.type === 'tool_result')) {
    return true;
  }
  return false;
}

/** Human-readable text of a real user line (string content or text blocks). */
export function extractUserText(line: Record<string, unknown>): string | undefined {
  const message = asRecord(line.message);
  const content = message?.content;
  if (typeof content === 'string') return content;
  const blocks = contentBlocks(content);
  if (!blocks) return undefined;
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text) ?? '')
    .join(' ')
    .trim();
  return text || undefined;
}

// ---------------------------------------------------------------------------
// Head scan: identity + title candidates
// ---------------------------------------------------------------------------

interface ClaudeHeadInfo {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  firstPromptTitle?: string;
  summaryTitle?: string;
  messagesSeen: number;
}

function scanClaudeHead(lines: string[]): ClaudeHeadInfo {
  const info: ClaudeHeadInfo = { messagesSeen: 0 };
  let scanned = 0;
  for (const raw of lines) {
    if (scanned >= HEAD_LINE_CAP) break;
    const parsed = asRecord(parseJsonLine(raw));
    if (!parsed) continue;
    scanned += 1;
    if (!info.sessionId) info.sessionId = asString(parsed.sessionId);
    if (!info.cwd) info.cwd = asString(parsed.cwd);
    if (!info.gitBranch) info.gitBranch = asString(parsed.gitBranch);
    if (parsed.type === 'user' || parsed.type === 'assistant') {
      info.messagesSeen += 1;
    }
    if (!info.firstPromptTitle && parsed.type === 'user' && !isSyntheticClaudeUserLine(parsed)) {
      info.firstPromptTitle = extractUserText(parsed);
    }
    if (!info.summaryTitle && parsed.type === 'summary') {
      info.summaryTitle = asString(parsed.summary);
    }
    if (!info.model && parsed.type === 'assistant') {
      const message = asRecord(parsed.message);
      const model = asString(message?.model);
      // Synthetic error replies carry placeholders like "<synthetic>".
      if (model && !model.startsWith('<')) info.model = model;
    }
  }
  return info;
}

// ---------------------------------------------------------------------------
// Tail scan: three-signal state inputs
// ---------------------------------------------------------------------------

interface IndexedLine {
  index: number;
  line: Record<string, unknown>;
}

function toolUseIds(line: Record<string, unknown>): string[] {
  const message = asRecord(line.message);
  const blocks = contentBlocks(message?.content) ?? [];
  return blocks
    .filter((block) => block.type === 'tool_use')
    .map((block) => asString(block.id))
    .filter((id): id is string => Boolean(id));
}

function toolResultIds(line: Record<string, unknown>): string[] {
  const message = asRecord(line.message);
  const blocks = contentBlocks(message?.content) ?? [];
  return blocks
    .filter((block) => block.type === 'tool_result')
    .map((block) => asString(block.tool_use_id))
    .filter((id): id is string => Boolean(id));
}

/** Extract tail signals from the parsed tail window (oldest → newest).
 * A tool_use whose result fell outside the tail window reads as unclosed —
 * acceptable false-positive towards Executing, documented in the plan. */
export function analyzeClaudeTail(lines: string[]): ClaudeTailSignals {
  const parsed: IndexedLine[] = [];
  let index = 0;
  for (const raw of lines) {
    const line = asRecord(parseJsonLine(raw));
    if (line) parsed.push({ index, line });
    index += 1;
  }
  let lastRealUser = -1;
  let lastAssistant = -1;
  let lastToolUse: { index: number; ids: string[] } | null = null;
  let messagesSeen = 0;
  for (const entry of parsed) {
    const { line } = entry;
    if (line.type === 'user') {
      messagesSeen += 1;
      if (!isSyntheticClaudeUserLine(line)) lastRealUser = entry.index;
      for (const id of toolResultIds(line)) {
        if (lastToolUse && entry.index > lastToolUse.index) {
          lastToolUse.ids = lastToolUse.ids.filter((open) => open !== id);
        }
      }
    } else if (line.type === 'assistant') {
      messagesSeen += 1;
      lastAssistant = entry.index;
      const ids = toolUseIds(line);
      if (ids.length > 0) lastToolUse = { index: entry.index, ids };
    }
  }
  return {
    kind: 'claude',
    trailingRealUser: lastRealUser !== -1 && lastRealUser > lastAssistant,
    unclosedToolUse: lastToolUse !== null && lastToolUse.ids.length > 0,
    messagesSeen,
  };
}

// ---------------------------------------------------------------------------
// File → signal
// ---------------------------------------------------------------------------

/** Parse one transcript into a file signal. Returns null when the file has
 * no extractable identity (sessionId + cwd) — corrupt files degrade, they
 * never throw. */
export async function parseClaudeTranscript(ref: StateFileRef): Promise<ObservedFileSignal | null> {
  try {
    const head = await readWindowLines(ref.filePath, 'head', HEAD_WINDOW_BYTES);
    const headInfo = scanClaudeHead(head.lines);
    if (!headInfo.sessionId || !headInfo.cwd) return null;
    const tail = await readWindowLines(ref.filePath, 'tail', TAIL_WINDOW_BYTES);
    const tailSignals = analyzeClaudeTail(tail.lines);
    tailSignals.messagesSeen += headInfo.messagesSeen;
    return {
      clientKind: 'claude-code',
      nativeSessionId: headInfo.sessionId,
      cwd: headInfo.cwd,
      filePath: ref.filePath,
      mtimeMs: ref.mtimeMs,
      sizeBytes: ref.sizeBytes,
      model: headInfo.model,
      tailSignals: {
        ...tailSignals,
        firstPromptTitle: headInfo.firstPromptTitle,
        summaryTitle: headInfo.summaryTitle,
        gitBranch: headInfo.gitBranch,
      },
    };
  } catch {
    return null;
  }
}

export const CLAUDE_LIMITS = { SCAN_FILE_CAP, HEAD_LINE_CAP, MAX_LINE_BYTES } as const;
