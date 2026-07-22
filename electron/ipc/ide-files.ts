// ide-files.ts — secure file-browsing IPC for OpenCode editor windows.
//
// Replaces the removed opencode-files IPC, which trusted a renderer-supplied
// `cwd` (any renderer could read any file ≤512KB on disk, and its isPathSafe
// check did no realpath resolution, so symlinks escaped the root anyway).
//
// Security model here (registered via the validators.ts handleSecure gate):
//  - The renderer NEVER supplies a cwd. The workspace root is resolved from
//    the window registry: the IPC sender must be a registered editor window,
//    and the { hostId, cwd } stored at window creation time is used.
//  - Payloads are validated with zod (strict — unknown keys rejected).
//  - Both the root and the target go through realpath; the resolved target
//    must equal the resolved root or live underneath it. This closes `..`
//    traversal, absolute paths, and symlink escapes.
//  - Files larger than 512KB are refused.

import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { resolveEditorContextByWebContentsId } from '../ide/ide-window-manager.js';
import { editorWindowSenderPolicy, handleSecure } from './validators.js';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  /** File mtime at read time — the editor sends it back as expectedMtime
   *  for optimistic-concurrency writes. */
  mtimeMs: number;
}

const MAX_FILE_SIZE = 512 * 1024; // 512KB
const MAX_PATH_LENGTH = 4096;

// Heavy or noise directories hidden from the editor file tree.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-electron',
  'release',
  '.next',
  'coverage',
]);

export const ideFilesListPayloadSchema = z
  .object({ path: z.string().max(MAX_PATH_LENGTH).optional() })
  .strict();

export const ideFilesReadPayloadSchema = z
  .object({ path: z.string().min(1).max(MAX_PATH_LENGTH) })
  .strict();

export const ideFilesWritePayloadSchema = z
  .object({
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    content: z.string().max(MAX_FILE_SIZE),
    /** Optimistic concurrency: the mtime the editor read. Mismatch → the
     *  write is refused as a conflict instead of clobbering newer edits. */
    expectedMtime: z.number().nonnegative().optional(),
  })
  .strict();

/** mtime conflict check with a small epsilon for filesystems whose mtime
 *  granularity is coarser than milliseconds. */
export function isMtimeConflict(expectedMtime: number, actualMtime: number): boolean {
  return Math.abs(expectedMtime - actualMtime) > 1;
}

/** Pure confinement check on already-resolved paths: target must be the root
 *  itself or a descendant. The trailing-separator comparison is what rejects
 *  sibling-prefix traps like root=/a/b vs target=/a/bc. Exported for tests. */
export function isPathConfined(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export type ConfinedPathResult =
  | { ok: true; root: string; target: string }
  | { ok: false; error: string };

/** Resolve relPath against root and confine the result to root, with symlink
 *  resolution on BOTH ends. Missing targets are reported as not-found (the
 *  ENOENT case) instead of leaking errno details. Exported for tests. */
export async function resolveConfinedPath(
  workspaceRoot: string,
  relPath?: string,
): Promise<ConfinedPathResult> {
  let root: string;
  try {
    root = await realpath(resolve(workspaceRoot));
  } catch {
    return { ok: false, error: 'Workspace root not found' };
  }

  // resolve() also neutralizes absolute relPath tricks: an absolute second
  // argument discards root entirely, and the confinement check below then
  // rejects it (unless it happens to land back inside root).
  const candidate = resolve(root, relPath ?? '.');
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    // ENOENT (missing file), ELOOP (symlink loop), ENOTDIR, EACCES — all
    // collapse to a single not-found answer.
    return { ok: false, error: 'Path not found' };
  }

  if (!isPathConfined(root, target)) {
    return { ok: false, error: 'Path outside workspace' };
  }
  return { ok: true, root, target };
}

/** Write variant of resolveConfinedPath: existing targets go through the
 *  same realpath confinement; NEW files are confined via their parent
 *  directory's realpath (realpath on the target itself would ENOENT). */
export async function resolveConfinedWriteTarget(
  workspaceRoot: string,
  relPath: string,
): Promise<ConfinedPathResult> {
  const existing = await resolveConfinedPath(workspaceRoot, relPath);
  if (existing.ok) return existing;

  let root: string;
  try {
    root = await realpath(resolve(workspaceRoot));
  } catch {
    return { ok: false, error: 'Workspace root not found' };
  }
  const candidate = resolve(root, relPath);
  let parentReal: string;
  try {
    parentReal = await realpath(dirname(candidate));
  } catch {
    return { ok: false, error: 'Parent directory not found' };
  }
  if (!isPathConfined(root, parentReal)) {
    return { ok: false, error: 'Path outside workspace' };
  }
  // Re-anchor the filename on the REAL parent path so a symlinked parent
  // can't smuggle the write elsewhere.
  return { ok: true, root, target: join(parentReal, basename(candidate)) };
}

function getEditorCwd(senderId: number): string | null {
  return resolveEditorContextByWebContentsId(senderId)?.cwd ?? null;
}

export function registerIdeFilesIpc(): void {
  handleSecure('ide-files:list', {
    schema: ideFilesListPayloadSchema,
    authorize: editorWindowSenderPolicy(),
    authorizeError: 'Sender is not a registered editor window',
    handler: async (payload, senderId) => {
      // authorize already proved registration; re-fetch (with a null-check)
      // because the window could theoretically close between the two reads.
      const cwd = getEditorCwd(senderId);
      if (!cwd) {
        return { ok: false, error: 'Sender is not a registered editor window' };
      }
      const confined = await resolveConfinedPath(cwd, payload.path);
      if (!confined.ok) {
        return { ok: false, error: confined.error };
      }

      const entries = await readdir(confined.target, { withFileTypes: true });
      const result: FileEntry[] = await Promise.all(
        entries
          .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
          .map(async (e) => {
            const fullPath = join(confined.target, e.name);
            const stats = await stat(fullPath).catch(() => null);
            return {
              name: e.name,
              path: relative(confined.root, fullPath),
              isDir: e.isDirectory(),
              size: stats?.size ?? 0,
              modifiedAt: stats?.mtimeMs ?? 0,
            };
          }),
      );

      // Sort: dirs first, then files, alphabetically
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { ok: true, entries: result };
    },
  });

  handleSecure('ide-files:read', {
    schema: ideFilesReadPayloadSchema,
    authorize: editorWindowSenderPolicy(),
    authorizeError: 'Sender is not a registered editor window',
    handler: async (payload, senderId) => {
      const cwd = getEditorCwd(senderId);
      if (!cwd) {
        return { ok: false, error: 'Sender is not a registered editor window' };
      }
      const confined = await resolveConfinedPath(cwd, payload.path);
      if (!confined.ok) {
        return { ok: false, error: confined.error };
      }

      const stats = await stat(confined.target);
      if (!stats.isFile()) {
        return { ok: false, error: 'Not a file' };
      }
      if (stats.size > MAX_FILE_SIZE) {
        return { ok: false, error: 'File too large' };
      }

      const content = await readFile(confined.target, 'utf-8');
      return {
        ok: true,
        file: {
          path: relative(confined.root, confined.target),
          content,
          truncated: false,
          mtimeMs: stats.mtimeMs,
        } as FileContent,
      };
    },
  });

  // File write (Phase 4): same confinement + 512KB cap as read, plus
  // optimistic concurrency via expectedMtime. Manual save is an explicit
  // user action through the validated IPC path — no native dialog (v1.2 §5).
  // After the write, the server's file watcher (EventFileWatcherUpdated)
  // is what lets the agent notice the change; the UI also refreshes.
  handleSecure('ide-files:write', {
    schema: ideFilesWritePayloadSchema,
    authorize: editorWindowSenderPolicy(),
    authorizeError: 'Sender is not a registered editor window',
    handler: async (payload, senderId) => {
      const editorContext = resolveEditorContextByWebContentsId(senderId);
      if (!editorContext) {
        return { ok: false, error: 'Sender is not a registered editor window' };
      }
      const confined = await resolveConfinedWriteTarget(editorContext.cwd, payload.path);
      if (!confined.ok) {
        return { ok: false, error: confined.error };
      }

      const before = await stat(confined.target).catch(() => null);
      if (payload.expectedMtime !== undefined) {
        if (!before) {
          return { ok: false, error: 'File no longer exists', conflict: true };
        }
        if (isMtimeConflict(payload.expectedMtime, before.mtimeMs)) {
          return {
            ok: false,
            error: 'File changed on disk since you opened it',
            conflict: true,
            currentMtime: before.mtimeMs,
          };
        }
      }

      await writeFile(confined.target, payload.content, 'utf8');
      const after = await stat(confined.target);
      return {
        ok: true,
        file: {
          path: relative(confined.root, confined.target),
          content: payload.content,
          truncated: false,
          mtimeMs: after.mtimeMs,
        } as FileContent,
      };
    },
  });
}
