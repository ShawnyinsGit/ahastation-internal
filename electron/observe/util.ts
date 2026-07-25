// util.ts — safety + IO primitives shared by the observation layer.
//
// Implements the "safety trio" from the tech plan §4.1.6: symlink
// fail-closed, display redaction, per-line size cap, plus path-component
// sanitization for externally-sourced ids. All file access is O_RDONLY.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

export const MAX_LINE_BYTES = 10 * 1024 * 1024;
export const HEAD_WINDOW_BYTES = 512 * 1024;
export const TAIL_WINDOW_BYTES = 64 * 1024;

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Make an externally-sourced id safe to use as a single path component.
 * Rejects path separators and dot-traversal by construction. */
export function sanitizePathComponent(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-proj-[A-Za-z0-9_-]+/g,
  /\bghp_[A-Za-z0-9]+/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

/** Mask well-known secret shapes before anything reaches the UI. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) =>
      match.toLowerCase().startsWith('bearer') ? 'Bearer [REDACTED]' : '[REDACTED]',
    );
  }
  return out;
}

// Terminal C0/C1 control chars (whitespace \t\n\r survives here; the title
// pipeline collapses it) plus Unicode bidi override/isolate controls —
// defense against terminal injection through externally-sourced strings.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF]/g;
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;

export function stripControlChars(text: string): string {
  return text.replace(BIDI_CONTROLS, '').replace(CONTROL_CHARS, '');
}

/** Title pipeline: strip control chars → redact secrets → collapse
 * whitespace → truncate. Applied to every externally-sourced display string. */
export function sanitizeTitle(text: string, maxLen = 60): string {
  const cleaned = redactSecrets(stripControlChars(text)).replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1)}…`;
}

/** lstat wrapper: any error is treated as "skip this entry" (fail-closed).
 * Callers must also skip when the result is a symbolic link. */
export async function lstatSafe(path: string) {
  try {
    return await fs.lstat(path);
  } catch {
    return null;
  }
}

export interface WindowLines {
  lines: string[];
  /** True when the window did not cover the requested side of the file. */
  truncated: boolean;
}

/** Read a bounded head or tail window of a file, O_RDONLY, and split it
 * into lines. Partial lines at the cut edge are dropped. Lines longer than
 * MAX_LINE_BYTES are blanked so callers skip them without ever
 * materializing the full line. */
export async function readWindowLines(
  filePath: string,
  side: 'head' | 'tail',
  windowBytes: number,
): Promise<WindowLines> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size === 0) return { lines: [], truncated: false };
    const length = Math.min(windowBytes, size);
    const offset = side === 'head' ? 0 : size - length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    let lines = text.split('\n');
    const truncated = length < size;
    if (side === 'head' && truncated) {
      // Last element may be a partial line cut by the window.
      lines = lines.slice(0, -1);
    } else if (side === 'tail' && offset > 0) {
      // First element is a continuation of a line that started before the window.
      lines = lines.slice(1);
    }
    return {
      lines: lines.map((line) => (line.length > MAX_LINE_BYTES ? '' : line)),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

/** Parse one JSONL line; corrupt lines degrade to null (skip-and-continue). */
export function parseJsonLine(line: string): unknown | null {
  if (!line) return null;
  if (line.length > MAX_LINE_BYTES) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

export type ExecResult = { stdout: string; stderr: string };
export type ExecImpl = (
  cmd: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<ExecResult>;

const inFlight = new Map<string, Promise<ExecResult>>();

/** Default subprocess runner: promisified execFile with timeout + in-flight
 * dedup, so a slow `ps`/`lsof` never stacks duplicate children and never
 * blocks the event loop (codbash changelog lesson: sync polling froze the
 * terminal — everything here stays async off-loop). */
export const defaultExec: ExecImpl = (cmd, args, options) => {
  const key = `${cmd} ${args.join(' ')}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = new Promise<ExecResult>((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: options.timeoutMs, maxBuffer: options.maxBuffer },
      (error, stdout, stderr) => {
        // lsof exits non-zero when some pid has no visible files; stdout is
        // still valid, so surface partial output instead of failing hard.
        if (error && !stdout) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  }).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
};
