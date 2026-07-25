// statefiles/codex-desktop.ts — read-only scan of Codex Desktop threads.
//
// Codex Desktop (ChatGPT.app code mode) writes NO rollouts to
// ~/.codex/sessions/ — conversation content is not on local disk
// (logs_2.sqlite is app logs; memories_1.sqlite is background jobs). What
// exists and is used here:
//
//   ~/.codex/.codex-global-state.json
//     electron-persisted-atom-state → thread-descriptions-v1
//       {<threadId>: <human title>} — the app's curated thread titles
//     electron-persisted-atom-state → unread-thread-ids-by-host-v1
//       {<host>: [<threadId>]} — badge evidence
//     electron-persisted-atom-state → heartbeat-thread-permissions-by-id
//       {<threadId>: {…}} — badge evidence
//     active-workspace-roots: [<cwd>] (top level) — cwd fallback for
//       process-less threads
//   ~/.codex/process_manager/chat_processes.json
//     JSON array of chat-spawned processes: {chatTitle, command,
//     conversationId, cwd, id, itemId, osPid, processId, startedAtMs,
//     turnId, updatedAtMs}. conversationId equals the threadId used by
//     thread-descriptions-v1; osPid is a real OS pid (nullable) whose
//     liveness is checked downstream against the per-tick process snapshot.
//
// The app also exposes a JSON-RPC app-server over ~/.codex/ipc/ipc.sock —
// deliberately NOT used here (that is the future Connector route; this
// slice is file/process only).
//
// Safety: both files are read with a 2MB cap, symlinks fail closed, corrupt
// JSON degrades to an empty side of the join. All paths are constructed
// from homeDir, never taken from file content. Threads with no description
// AND no chat processes are skipped — there is nothing to show for them.
//
// Known gap: AhaStation's own codex-adapter talks to its own private
// `codex app-server --stdio` children and does not write here; if the
// app's own threads ever appear in thread-descriptions-v1 they would need
// the self-exclusion session-id seam (TODO(S1) in main.ts) to be hidden.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CodexDesktopTailSignals, ObservedFileSignal } from '../types.js';
import { asRecord, asString, lstatSafe, parseJsonLine } from '../util.js';

const GLOBAL_STATE_MAX_BYTES = 2 * 1024 * 1024;
const CHAT_PROCESSES_MAX_BYTES = 2 * 1024 * 1024;
const SCAN_THREAD_CAP = 50;

export interface CodexDesktopChatProcess {
  osPid?: number;
  cwd?: string;
  chatTitle?: string;
  updatedAtMs: number;
}

export interface CodexDesktopThreadRef {
  threadId: string;
  /** Evidence anchor: the global-state file when present, else the
   * chat-processes file. */
  filePath: string;
  /** Source-file mtime: global-state moves when threads change (activity
   * proxy); falls back to the chat-processes file mtime. */
  mtimeMs: number;
  /** Sum of both source files' sizes (change-marker input). */
  sizeBytes: number;
  description?: string;
  unread: boolean;
  heartbeat: boolean;
  /** active-workspace-roots[0] — cwd fallback for process-less threads. */
  workspaceRoot?: string;
  processes: CodexDesktopChatProcess[];
}

interface CappedRead {
  mtimeMs: number;
  sizeBytes: number;
  parsed: unknown | null;
}

/** lstat + bounded read + tolerant JSON parse. Any failure (absent,
 * symlink, oversize, unreadable, corrupt) degrades to null. */
async function readCappedStateFile(filePath: string, maxBytes: number): Promise<CappedRead | null> {
  const stat = await lstatSafe(filePath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) return null;
  if (stat.size > maxBytes) return null;
  let parsed: unknown | null = null;
  try {
    parsed = parseJsonLine(await fs.readFile(filePath, 'utf8'));
  } catch {
    parsed = null;
  }
  return { mtimeMs: stat.mtimeMs, sizeBytes: stat.size, parsed };
}

/** Join global-state descriptions with chat-spawned processes by
 * conversationId, newest activity first. Either file may be missing or
 * corrupt — the other side of the join still produces threads. */
export async function listCodexDesktopThreads(
  homeDir: string,
  cap = SCAN_THREAD_CAP,
): Promise<CodexDesktopThreadRef[]> {
  const globalPath = join(homeDir, '.codex', '.codex-global-state.json');
  const procsPath = join(homeDir, '.codex', 'process_manager', 'chat_processes.json');
  const [globalFile, procsFile] = await Promise.all([
    readCappedStateFile(globalPath, GLOBAL_STATE_MAX_BYTES),
    readCappedStateFile(procsPath, CHAT_PROCESSES_MAX_BYTES),
  ]);
  if (!globalFile && !procsFile) return [];

  const globalState = asRecord(globalFile?.parsed);
  const atom = asRecord(globalState?.['electron-persisted-atom-state']);
  const descriptions = asRecord(atom?.['thread-descriptions-v1']);
  const unreadByHost = asRecord(atom?.['unread-thread-ids-by-host-v1']);
  const heartbeatById = asRecord(atom?.['heartbeat-thread-permissions-by-id']);
  const rootsRaw = globalState?.['active-workspace-roots'];
  const workspaceRoot = Array.isArray(rootsRaw)
    ? rootsRaw.find((root): root is string => typeof root === 'string' && root.length > 0)
    : undefined;

  const unreadIds = new Set<string>();
  if (unreadByHost) {
    for (const value of Object.values(unreadByHost)) {
      if (!Array.isArray(value)) continue;
      for (const id of value) {
        if (typeof id === 'string' && id) unreadIds.add(id);
      }
    }
  }

  const byConversation = new Map<string, CodexDesktopChatProcess[]>();
  if (procsFile && Array.isArray(procsFile.parsed)) {
    for (const entry of procsFile.parsed) {
      const record = asRecord(entry);
      if (!record) continue;
      const conversationId = asString(record.conversationId);
      if (!conversationId) continue;
      const osPid = typeof record.osPid === 'number'
        && Number.isInteger(record.osPid) && record.osPid > 0
        ? record.osPid
        : undefined;
      const proc: CodexDesktopChatProcess = {
        osPid,
        cwd: asString(record.cwd),
        chatTitle: asString(record.chatTitle),
        updatedAtMs: typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
          ? record.updatedAtMs
          : 0,
      };
      const list = byConversation.get(conversationId);
      if (list) list.push(proc);
      else byConversation.set(conversationId, [proc]);
    }
  }

  const threadIds = new Set<string>(byConversation.keys());
  if (descriptions) {
    for (const [id, value] of Object.entries(descriptions)) {
      if (id && asString(value)) threadIds.add(id);
    }
  }

  const mtimeMs = globalFile?.mtimeMs ?? procsFile?.mtimeMs ?? 0;
  const sizeBytes = (globalFile?.sizeBytes ?? 0) + (procsFile?.sizeBytes ?? 0);
  const filePath = globalFile ? globalPath : procsPath;
  const threads: CodexDesktopThreadRef[] = [];
  for (const threadId of threadIds) {
    const description = descriptions ? asString(descriptions[threadId]) : undefined;
    const processes = byConversation.get(threadId) ?? [];
    if (!description && processes.length === 0) continue; // nothing to show
    threads.push({
      threadId,
      filePath,
      mtimeMs,
      sizeBytes,
      description,
      unread: unreadIds.has(threadId),
      heartbeat: heartbeatById ? Object.hasOwn(heartbeatById, threadId) : false,
      workspaceRoot,
      processes,
    });
  }
  threads.sort((a, b) => threadActivityMs(b) - threadActivityMs(a));
  return threads.slice(0, cap);
}

function threadActivityMs(ref: CodexDesktopThreadRef): number {
  return ref.processes.reduce((max, proc) => Math.max(max, proc.updatedAtMs), ref.mtimeMs);
}

/** Majority cwd of the thread's chat processes (ties keep the first-seen
 * cwd); undefined when the thread has no cwd-carrying processes. */
export function majorityChatCwd(processes: CodexDesktopChatProcess[]): string | undefined {
  const counts = new Map<string, number>();
  for (const proc of processes) {
    if (!proc.cwd) continue;
    counts.set(proc.cwd, (counts.get(proc.cwd) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [cwd, count] of counts) {
    if (count > bestCount) {
      best = cwd;
      bestCount = count;
    }
  }
  return best;
}

/** Pure ref → signal projection (all IO already happened in the list
 * step). Title chain: thread description (global-state) → chatTitle
 * (process-manager index) → undefined (project+time fallback downstream).
 * Returns null when no cwd evidence exists at all. */
export function parseCodexDesktopThread(ref: CodexDesktopThreadRef): ObservedFileSignal | null {
  try {
    if (!ref.threadId) return null;
    const cwd = majorityChatCwd(ref.processes) ?? ref.workspaceRoot;
    if (!cwd) return null;
    const chatPids: number[] = [];
    let lastChatUpdateAtMs = 0;
    let chatTitle: string | undefined;
    for (const proc of ref.processes) {
      if (proc.osPid !== undefined) chatPids.push(proc.osPid);
      if (proc.updatedAtMs > lastChatUpdateAtMs) lastChatUpdateAtMs = proc.updatedAtMs;
      if (!chatTitle && proc.chatTitle) chatTitle = proc.chatTitle;
    }
    const title = ref.description ?? chatTitle;
    const tailSignals: CodexDesktopTailSignals = {
      kind: 'codex-desktop',
      chatPids,
      lastChatUpdateAtMs,
      unread: ref.unread,
      heartbeat: ref.heartbeat,
    };
    return {
      // Desktop is the same client to the user; the desktop host shows up
      // in `evidence`, not in a new clientKind.
      clientKind: 'codex',
      nativeSessionId: ref.threadId,
      cwd,
      filePath: ref.filePath,
      mtimeMs: ref.mtimeMs,
      sizeBytes: ref.sizeBytes,
      title,
      titleSource: title ? (ref.description ? 'global-state' : 'session-index') : undefined,
      tailSignals,
    };
  } catch {
    return null;
  }
}

export const CODEX_DESKTOP_LIMITS = {
  GLOBAL_STATE_MAX_BYTES,
  CHAT_PROCESSES_MAX_BYTES,
  SCAN_THREAD_CAP,
} as const;
