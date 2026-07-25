// process/darwin.ts — macOS process scanning for the observation layer.
//
// One `ps -axo pid,ppid,tt,%cpu,rss,comm,args` per tick builds a snapshot
// shared by every observer (no per-client respawns). A single batched
// `lsof -Fn -p <pids>` resolves cwd / open files only for pids that matched
// a client binary. All subprocess calls are async off-loop with timeout +
// in-flight dedup (see util.defaultExec). Ports are out of scope for S0.

import { defaultExec, type ExecImpl } from '../util.js';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  command: string;
  comm: string;
  cpuPct: number;
  rssKb: number;
  /** Controlling terminal exactly as ps reports it ('s003', or '??' when the
   *  process has none). Session actions treat '??' as "no tty". */
  tty: string;
}

export interface ProcessSnapshot {
  byPid: Map<number, ProcessInfo>;
  childrenOf: Map<number, number[]>;
  capturedAt: number;
}

const PS_TIMEOUT_MS = 5_000;
const LSOF_TIMEOUT_MS = 10_000;
const PS_MAX_BUFFER = 16 * 1024 * 1024;

/** Parse `ps -axo pid,ppid,tt,%cpu,rss,comm,args` output. The comm column is
 * truncated to a fixed width by ps, so the args column is located via the
 * header's ARGS offset instead of token splitting (comm may contain
 * spaces, e.g. "Electron Helper (Renderer)"). */
export function parsePsOutput(text: string, capturedAt = Date.now()): ProcessSnapshot {
  const lines = text.split('\n');
  const byPid = new Map<number, ProcessInfo>();
  const childrenOf = new Map<number, number[]>();
  if (lines.length === 0) return { byPid, childrenOf, capturedAt };
  const header = lines[0];
  const argsStart = header.indexOf('ARGS');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const tty = match[3];
    const cpuPct = Number(match[4]);
    const rssKb = Number(match[5]);
    const rest = match[6];
    let comm: string;
    let command: string;
    if (argsStart > 0 && line.length > argsStart) {
      command = line.slice(argsStart).trimEnd();
      comm = rest.slice(0, Math.max(0, rest.length - command.length)).trim();
    } else {
      // Fallback: line too short for column math — first token is comm.
      const spaceIdx = rest.search(/\s/);
      comm = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      command = spaceIdx === -1 ? rest : rest.slice(spaceIdx).trim();
    }
    if (!command) command = comm;
    byPid.set(pid, { pid, ppid, command, comm, cpuPct, rssKb, tty });
    const siblings = childrenOf.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  return { byPid, childrenOf, capturedAt };
}

/** Capture the shared per-tick process snapshot (single ps invocation). */
export async function captureProcessSnapshot(
  execImpl: ExecImpl = defaultExec,
): Promise<ProcessSnapshot> {
  const { stdout } = await execImpl(
    'ps',
    ['-axo', 'pid,ppid,tt,%cpu,rss,comm,args'],
    { timeoutMs: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
  );
  return parsePsOutput(stdout);
}

const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/** Token-level binary-name match against a full command line.
 * Handles node wrappers (`node .../codex.js`), npm shims
 * (`/usr/local/bin/codex`) and `.exe` suffixes, without matching tokens
 * where the name only appears inside a path argument
 * (`code /home/me/.claude` → basename `.claude` ≠ `claude`). */
export function cmdHasBinary(command: string, name: string): boolean {
  const tokens = command.split(/\s+/);
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^["']|["']$/g, '');
    if (!token) continue;
    // Basename on both POSIX and Windows separators.
    const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
    if (!base) continue;
    if (base === name) return true;
    if (base === `${name}.exe`) return true;
    for (const ext of SCRIPT_EXTENSIONS) {
      if (base === `${name}${ext}`) return true;
    }
  }
  return false;
}

/** Processes that may contain a client binary name but are never user CLI
 * sessions (Electron helper trees, MCP servers, plugin hosts, greps). */
const EXCLUSION_PATTERNS: RegExp[] = [
  /--type=/, // Electron renderer/utility/gpu subprocesses
  /\.app\/Contents\/(Frameworks|MacOS|Helpers)\//, // bundled app binaries (Claude Desktop etc.)
  / Helper(\.app|\s*\(|$)/, // "* Helper" / "* Helper (Renderer)"
  /mcp-server/,
  /\/plugins\//,
  /app-server-broker/,
  // `codex ... app-server` is the Codex Desktop host (ChatGPT.app code
  // mode) or AhaStation's own adapter child — never a user CLI session.
  // Desktop hosts are routed to detectCodexDesktopHostPids instead. Token
  // match: `app-server-broker` (above) must NOT match here.
  /(?:^|\s)app-server(?:\s|$)/,
  /^\s*(grep|rg)\b/, // the search that found the name
];

export function isExcludedCommand(command: string): boolean {
  return EXCLUSION_PATTERNS.some((pattern) => pattern.test(command));
}

/** Pids in the snapshot whose command runs any of `binaryNames`, after
 * applying the exclusion list. */
export function findClientPids(snapshot: ProcessSnapshot, binaryNames: string[]): number[] {
  const pids: number[] = [];
  for (const info of snapshot.byPid.values()) {
    if (isExcludedCommand(info.command)) continue;
    if (binaryNames.some((name) => cmdHasBinary(info.command, name))) {
      pids.push(info.pid);
    }
  }
  return pids;
}

/** Descendants of `pid` up to `maxDepth` levels (claude --resume double-
 * forks, so direct children alone are not enough). Cycle-protected: ps
 * output can contain a ppid loop on a racing process table. */
export function descendantsOf(
  snapshot: ProcessSnapshot,
  pid: number,
  maxDepth = 2,
): Set<number> {
  const found = new Set<number>();
  let frontier = [pid];
  const visited = new Set<number>([pid]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const current of frontier) {
      for (const child of snapshot.childrenOf.get(current) ?? []) {
        if (visited.has(child)) continue;
        visited.add(child);
        found.add(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

/** CPU signal: max %cpu over the two-level descendant tree. */
export function maxDescendantCpu(snapshot: ProcessSnapshot, pid: number): number {
  let max = 0;
  for (const child of descendantsOf(snapshot, pid, 2)) {
    const info = snapshot.byPid.get(child);
    if (info && info.cpuPct > max) max = info.cpuPct;
  }
  return max;
}

export interface LsofProcessFiles {
  cwd?: string;
  files: string[];
}

/** Parse `lsof -Fn -p <pids>` field output. Records are `p<pid>` /
 * `f<fd>` / `n<name>` lines; the cwd is the `n` line following `fcwd`.
 * Entries whose name carries a readlink permission error are dropped;
 * socket-style names (`->...`) are not files. */
export function parseLsofFieldOutput(text: string): Map<number, LsofProcessFiles> {
  const result = new Map<number, LsofProcessFiles>();
  let currentPid: number | null = null;
  let expectCwd = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      currentPid = Number(value);
      expectCwd = false;
      if (!result.has(currentPid)) result.set(currentPid, { files: [] });
      continue;
    }
    if (currentPid === null) continue;
    const entry = result.get(currentPid);
    if (!entry) continue;
    if (tag === 'f') {
      expectCwd = value === 'cwd';
      continue;
    }
    if (tag !== 'n') continue;
    if (value.includes('Permission denied')) {
      expectCwd = false;
      continue;
    }
    if (expectCwd) {
      entry.cwd = value;
      expectCwd = false;
      continue;
    }
    if (value.startsWith('->') || value === '(none)') continue;
    entry.files.push(value);
  }
  return result;
}

/** Batched lsof for a set of pids. Any failure degrades to "cwd unknown"
 * for every pid (the process still counts as existing). */
export async function lsofOpenFiles(
  pids: number[],
  execImpl: ExecImpl = defaultExec,
): Promise<Map<number, LsofProcessFiles>> {
  if (pids.length === 0) return new Map();
  try {
    const { stdout } = await execImpl(
      'lsof',
      ['-Fn', '-p', pids.join(',')],
      { timeoutMs: LSOF_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
    );
    return parseLsofFieldOutput(stdout);
  } catch {
    return new Map();
  }
}
