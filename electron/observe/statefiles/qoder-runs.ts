// statefiles/qoder-runs.ts — read-only scan of Qoder CLI runs.
//
// Data source: ~/.qoder/logs/runs/<run_id>/manifest.json — one directory per
// qodercli process launch, named `<iso8601>-<rand>-p<pid>`. The manifest
// carries { run_id, pid, ppid, cwd, started_at, cli_version, process_role,
// argv } — enough to correlate observed qodercli processes with their
// workspace and start time. The sibling qodercli.log provides a last-event
// timestamp via its tail window.
//
// Verified against qodercli 1.0.47 (QoderWork bundled, 2026-07): interactive
// TUI sessions create run dirs exactly like one-shot invocations; there is
// no per-conversation state file on disk (session content lives in memory /
// server-side), and `qodercli jobs` only tracks --worktree jobs, so this
// manifest scan is the only local observation source.
//
// Safety: run dirs are only honored inside ~/.qoder/logs/runs/ (containment
// is structural — entries come from readdir there). manifest.json is read
// with a 1MB cap, the log with the shared 64KB tail window. Symlinks fail
// closed: a symlinked run dir or manifest skips the run; a symlinked/missing
// log degrades to zero tail signals.
//
// Wiring note: this reader is intentionally NOT yet wired into
// ClientKind/ObserveService — the observe pipeline is being actively
// reworked on another branch; wiring lands in a follow-up to avoid
// conflicting edits in correlate.ts / mapping.ts / observe-service.ts.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TAIL_WINDOW_BYTES,
  asRecord,
  asString,
  lstatSafe,
  parseJsonLine,
  readWindowLines,
} from '../util.js';
import type { StateFileRef } from './claude-projects.js';

const SCAN_RUN_CAP = 50;
const MANIFEST_MAX_BYTES = 1024 * 1024;

export interface QoderRunRef extends StateFileRef {
  runId: string;
  runDir: string;
  logPath: string;
  /** manifest.json fs mtime — sort key. */
  manifestMtimeMs: number;
}

export interface QoderRunInfo {
  runId: string;
  pid: number | null;
  ppid: number | null;
  cwd?: string;
  projectId?: string;
  startedAt?: string;
  startedAtMs: number;
  cliVersion?: string;
  processRole?: string;
  /** Max leading ISO timestamp seen in the qodercli.log tail; 0 when the
   *  log is missing/symlinked or carries no timestamps. */
  lastLogEventAtMs: number;
}

/** Tolerant parse of the (capped) manifest.json text; null when unreadable
 *  or missing the run_id. */
export function parseQoderRunManifest(text: string): {
  runId: string;
  pid: number | null;
  ppid: number | null;
  cwd?: string;
  projectId?: string;
  startedAt?: string;
  startedAtMs: number;
  cliVersion?: string;
  processRole?: string;
} | null {
  const parsed = asRecord(parseJsonLine(text));
  if (!parsed) return null;
  const runId = asString(parsed.run_id);
  if (!runId) return null;
  const startedAt = asString(parsed.started_at);
  const startedAtMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const pid = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null;
  const ppid = typeof parsed.ppid === 'number' && Number.isInteger(parsed.ppid) ? parsed.ppid : null;
  return {
    runId,
    pid,
    ppid,
    cwd: asString(parsed.cwd),
    projectId: asString(parsed.project_id),
    startedAt,
    startedAtMs: Number.isNaN(startedAtMs) ? 0 : startedAtMs,
    cliVersion: asString(parsed.cli_version),
    processRole: asString(parsed.process_role),
  };
}

/** Newest-first list of run manifests under ~/.qoder/logs/runs, capped.
 *  Directory names start with an ISO timestamp so lexicographic order is
 *  chronological; the manifest mtime breaks ties and drives change markers.
 *  A missing/symlinked manifest skips the run; the log is optional. */
export async function listQoderRuns(
  homeDir: string,
  cap = SCAN_RUN_CAP,
): Promise<QoderRunRef[]> {
  const runsRoot = join(homeDir, '.qoder', 'logs', 'runs');
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return [];
  }
  // Newest directory names first (ISO-timestamp prefixed).
  entries.sort().reverse();
  const refs: QoderRunRef[] = [];
  for (const name of entries) {
    if (refs.length >= cap) break;
    const runDir = join(runsRoot, name);
    const dirStat = await lstatSafe(runDir);
    if (!dirStat || !dirStat.isDirectory() || dirStat.isSymbolicLink()) continue;
    const manifestPath = join(runDir, 'manifest.json');
    const manifestStat = await lstatSafe(manifestPath);
    if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) continue;
    if (manifestStat.size > MANIFEST_MAX_BYTES) continue;
    const logPath = join(runDir, 'qodercli.log');
    const logStat = await lstatSafe(logPath);
    const logOk = logStat && logStat.isFile() && !logStat.isSymbolicLink() ? logStat : null;
    refs.push({
      filePath: manifestPath,
      mtimeMs: Math.max(manifestStat.mtimeMs, logOk?.mtimeMs ?? 0),
      sizeBytes: manifestStat.size + (logOk?.size ?? 0),
      runId: name,
      runDir,
      logPath,
      manifestMtimeMs: manifestStat.mtimeMs,
    });
  }
  return refs;
}

const LOG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s/;

/** Max leading ISO timestamp in the qodercli.log tail window; 0 when none. */
export function analyzeQoderLogTail(lines: string[]): { lastLogEventAtMs: number } {
  let lastLogEventAtMs = 0;
  for (const line of lines) {
    const match = LOG_TIMESTAMP.exec(line);
    if (!match) continue;
    const ms = Date.parse(match[1]);
    if (!Number.isNaN(ms) && ms > lastLogEventAtMs) lastLogEventAtMs = ms;
  }
  return { lastLogEventAtMs };
}

/** Parse a run ref into its info record. Returns null when the manifest is
 *  unreadable (disappeared mid-scan, over cap, malformed). A missing log
 *  degrades to zero tail signals. */
export async function parseQoderRun(ref: QoderRunRef): Promise<QoderRunInfo | null> {
  let manifestText: string;
  try {
    const { lines: manifestLines } = await readWindowLines(
      ref.filePath,
      'head',
      MANIFEST_MAX_BYTES,
    );
    manifestText = manifestLines.join('\n');
  } catch {
    return null; // disappeared mid-scan
  }
  const manifest = parseQoderRunManifest(manifestText);
  if (!manifest) return null;
  let logLines: string[] = [];
  try {
    ({ lines: logLines } = await readWindowLines(ref.logPath, 'tail', TAIL_WINDOW_BYTES));
  } catch { /* missing/unreadable log — zero tail signals */ }
  const { lastLogEventAtMs } = analyzeQoderLogTail(logLines);
  return { ...manifest, lastLogEventAtMs };
}
