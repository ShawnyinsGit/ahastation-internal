// documents:* IPC — read a worker's just-delivered file off disk for the
// renderer's ScreenStage "delivery acceptance" panel. Path is validated to
// live under the active session's workspace cwd; renderer cannot ask for
// arbitrary files via this channel.
//
// Sibling `session:steer-worker` lives here too: the acceptance panel's
// "still needs work + 修改意见" button funnels feedback through it, which
// reaches Orchestrator.steerWorker → WorkerScheduler.steerWorker and lands on
// the same worker session as a (plan update) addendum.

import { dialog, ipcMain, shell } from 'electron';
import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, resolve as pathResolve, sep } from 'node:path';
import { formatError } from '../format-error.js';
import type { IpcContext } from './context.js';
import { classifyKind, parseAttachmentBuffer, type AttachmentKind } from '../attachments/parse.js';

// Cap any single deliverable we'll fetch into the renderer. 8 MB on disk
// covers code files, generated PDFs, screenshots, and short videos; anything
// larger we hand back as a "binary placeholder" entry so the user still sees
// it in the list without us streaming hundreds of MB across the IPC.
const MAX_READ_BYTES = 8 * 1024 * 1024;
// Text files: we slice the on-disk bytes to a renderer-friendly upper bound so
// a 5 MB generated log doesn't drag the preview pane down. The user can still
// open the file in their editor.
const MAX_TEXT_BYTES = 512 * 1024;

const IGNORED_NAMES = new Set([
  'node_modules', '.git', '.DS_Store', '__pycache__', '.venv', 'venv',
  '.next', '.nuxt', 'dist', '.cache', '.parcel-cache', '.turbo',
  'coverage', '.nyc_output', '.idea', '.vscode', 'Thumbs.db',
]);

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v']);
const VIDEO_MIME_BY_EXT: Record<string, 'video/mp4' | 'video/webm' | 'video/quicktime'> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};

export type DeliveryFileKind = AttachmentKind | 'pptx' | 'xlsx' | 'video' | 'binary' | 'missing';

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  ext: string;
}

export interface DirListResult {
  ok: true;
  entries: DirEntry[];
}

export interface DirListError {
  ok: false;
  error: string;
  code?: 'not-in-cwd' | 'no-session' | 'not-dir' | 'read-failed';
}

export interface DocumentReadResult {
  ok: true;
  path: string;
  name: string;
  sizeBytes: number;
  kind: DeliveryFileKind;
  /** UTF-8 text for text-like deliverables; may be truncated. */
  text?: string;
  /** True if `text` was sliced by MAX_TEXT_BYTES. */
  truncated?: boolean;
  /** Raw bytes for image/video kinds — passed via Electron's structured-clone
   *  IPC, so this is a zero-copy transfer in practice (no base64 encode on
   *  send + no atob on the renderer). Word/pdf NOT byte-shipped — they are
   *  parsed to text on the main side. */
  data?: Uint8Array;
  /** Legacy base64 payload, kept for one transition release so any old
   *  renderer build that still references `dataBase64` keeps working. New
   *  callers should read `data` instead. */
  dataBase64?: string;
  /** Media type for image/video kinds. */
  mediaType?: string;
}

export interface DocumentReadError {
  ok: false;
  error: string;
  code?: 'not-in-cwd' | 'no-session' | 'missing' | 'too-large' | 'read-failed' | 'invalid-path';
}

interface RawReadPayload {
  sessionId?: unknown;
  path?: unknown;
}

interface RawSteerPayload {
  sessionId?: unknown;
  workerId?: unknown;
  addendum?: unknown;
}

function pickSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const id = (payload as { sessionId?: unknown }).sessionId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function isUnderCwd(absPath: string, cwd: string): boolean {
  // Resolve both sides + ensure the path lives strictly under cwd. `..`
  // segments collapse via pathResolve; a malicious "/../etc/passwd" turns
  // into an absolute path outside cwd and fails the prefix check.
  const normalisedCwd = pathResolve(cwd) + sep;
  const normalisedPath = pathResolve(absPath) + sep;
  return normalisedPath.startsWith(normalisedCwd) || pathResolve(absPath) === pathResolve(cwd);
}

// Session-level allowlist for directories outside cwd that the user has
// explicitly approved via the native dialog. Keyed by slot id; not persisted.
const approvedExternalDirs = new Map<string, Set<string>>();

export function clearApprovedExternalDirs(slotId: string): void {
  approvedExternalDirs.delete(slotId);
}

function isExternalApproved(absPath: string, slotId: string): boolean {
  const approved = approvedExternalDirs.get(slotId);
  if (!approved || approved.size === 0) return false;
  const normalized = pathResolve(absPath);
  for (const dir of approved) {
    const normalizedDir = pathResolve(dir) + sep;
    if (normalized.startsWith(normalizedDir) || normalized === pathResolve(dir)) return true;
  }
  return false;
}

async function maybeAuthorizeExternal(
  displayPath: string,
  approveDir: string,
  slotId: string,
  ctx: IpcContext,
): Promise<boolean> {
  if (isExternalApproved(displayPath, slotId)) return true;
  const win = ctx.liveWindow();
  if (!win) return false;
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    title: '查看工作区外的文件',
    message: '此文件不在当前工作区内',
    detail: `路径: ${displayPath}\n\n是否允许访问此目录下的文件？`,
    buttons: ['拒绝', '允许'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (res.response !== 1) return false;
  if (!approvedExternalDirs.has(slotId)) {
    approvedExternalDirs.set(slotId, new Set());
  }
  approvedExternalDirs.get(slotId)!.add(approveDir);
  return true;
}

function extensionOf(name: string): string | null {
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return null;
  return name.slice(idx + 1).toLowerCase();
}

const PPTX_EXTENSIONS = new Set(['pptx', 'ppt']);
const XLSX_EXTENSIONS = new Set(['xlsx', 'xls', 'csv']);

function detectKind(name: string): DeliveryFileKind {
  const ext = extensionOf(name);
  if (ext && VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (ext && PPTX_EXTENSIONS.has(ext)) return 'pptx';
  if (ext && XLSX_EXTENSIONS.has(ext)) return 'xlsx';
  const k = classifyKind(name, '');
  if (k) return k;
  return 'binary';
}

export function registerDocumentsIpc(ctx: IpcContext): void {
  ipcMain.handle('documents:read', async (_e, payload: RawReadPayload): Promise<DocumentReadResult | DocumentReadError> => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session', code: 'no-session' };

    const rawPath = typeof payload?.path === 'string' ? payload.path : '';
    if (!rawPath) {
      return { ok: false, error: 'Path is required', code: 'invalid-path' };
    }

    const cwd = slot.cwd;
    if (!cwd) {
      return { ok: false, error: 'No workspace directory', code: 'no-session' };
    }
    const absPath = isAbsolute(rawPath) ? rawPath : pathResolve(cwd, rawPath);
    // Redirect the rest of the handler to the resolved absolute path.
    const resolvedRawPath = absPath;
    const pathInCwd = isUnderCwd(resolvedRawPath, cwd);
    const artifactRoot = slot.orchestrator.getDeliveryArtifactRoot();
    const pathInArtifacts = isUnderCwd(resolvedRawPath, artifactRoot);
    if (!pathInCwd && !pathInArtifacts) {
      const allowed = await maybeAuthorizeExternal(resolvedRawPath, dirname(resolvedRawPath), slot.id, ctx);
      if (!allowed) {
        return { ok: false, error: 'Path is not inside the session workspace', code: 'not-in-cwd' };
      }
    }

    // String-level isUnderCwd only collapses `../`; it cannot see through a
    // symlink whose target escapes cwd. Resolve symlinks to the real on-disk
    // path (and resolve cwd too, in case cwd itself is a symlink) and re-check
    // containment before any stat/read follows the link off the workspace.
    let realPath: string;
    try {
      realPath = await fs.realpath(resolvedRawPath);
    } catch {
      return { ok: false, error: `File not found: ${basename(resolvedRawPath)}`, code: 'missing' };
    }
    let realAllowedRoot: string;
    try {
      realAllowedRoot = await fs.realpath(pathInArtifacts ? artifactRoot : cwd);
    } catch {
      realAllowedRoot = pathInArtifacts ? artifactRoot : cwd;
    }
    if ((pathInCwd || pathInArtifacts) && !isUnderCwd(realPath, realAllowedRoot)) {
      console.warn(`[documents:read] symlink escape blocked: ${resolvedRawPath} -> ${realPath}`);
      return { ok: false, error: 'Path is not inside the session workspace', code: 'not-in-cwd' };
    }

    // Use the realpath-resolved path for all subsequent I/O to close the
    // TOCTOU window between the symlink check and the actual read.
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(realPath);
    } catch (err: unknown) {
      return { ok: false, error: `File not found: ${basename(resolvedRawPath)}`, code: 'missing' };
    }

    if (!stat.isFile()) {
      return { ok: false, error: 'Path is not a regular file', code: 'invalid-path' };
    }

    const sizeBytes = stat.size;
    const name = basename(resolvedRawPath);
    const kind = detectKind(name);

    if (sizeBytes > MAX_READ_BYTES) {
      return {
        ok: true,
        path: resolvedRawPath,
        name,
        sizeBytes,
        kind: 'binary',
      };
    }

    try {
      if (kind === 'text') {
        const buffer = await fs.readFile(realPath);
        const truncated = buffer.length > MAX_TEXT_BYTES;
        const slice = truncated ? buffer.subarray(0, MAX_TEXT_BYTES) : buffer;
        return {
          ok: true,
          path: resolvedRawPath,
          name,
          sizeBytes,
          kind: 'text',
          text: slice.toString('utf8'),
          truncated,
        };
      }

      if (kind === 'image') {
        const buffer = await fs.readFile(realPath);
        const ext = extensionOf(name);
        const mediaType =
          ext === 'png' ? 'image/png'
            : ext === 'webp' ? 'image/webp'
              : ext === 'gif' ? 'image/gif'
                : ext === 'svg' ? 'image/svg+xml'
                  : 'image/jpeg';
        return {
          ok: true,
          path: resolvedRawPath,
          name,
          sizeBytes,
          kind: 'image',
          data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
          mediaType,
        };
      }

      if (kind === 'video') {
        const buffer = await fs.readFile(realPath);
        const ext = extensionOf(name) ?? 'mp4';
        const mediaType = VIDEO_MIME_BY_EXT[ext] ?? 'video/mp4';
        return {
          ok: true,
          path: resolvedRawPath,
          name,
          sizeBytes,
          kind: 'video',
          data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
          mediaType,
        };
      }

      if (kind === 'word') {
        const buffer = await fs.readFile(realPath);
        let fallbackText = '';
        try {
          const parsed = await parseAttachmentBuffer({
            name,
            mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes,
            buffer,
          });
          fallbackText = parsed.text ?? '';
        } catch (err) { console.warn('[documents:read] DOCX text extraction failed:', basename(resolvedRawPath), err); }
        return {
          ok: true,
          path: resolvedRawPath,
          name,
          sizeBytes,
          kind: 'word',
          text: fallbackText,
          data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        };
      }

      if (kind === 'pdf') {
        const buffer = await fs.readFile(realPath);
        return {
          ok: true,
          path: resolvedRawPath,
          name,
          sizeBytes,
          kind: 'pdf',
          data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
          mediaType: 'application/pdf',
        };
      }

      // PPTX/XLSX are intentionally not parsed in-process. The previously used
      // preview packages pull vulnerable HTML/rendering dependencies and parse
      // attacker-controlled archives in the privileged main process. Users can
      // still open these files through documents:open-external.
      if (kind === 'pptx' || kind === 'xlsx') {
        return { ok: true, path: resolvedRawPath, name, sizeBytes, kind: 'binary' };
      }

      return {
        ok: true,
        path: resolvedRawPath,
        name,
        sizeBytes,
        kind: 'binary',
      };
    } catch (err: unknown) {
      return { ok: false, error: `Read failed: ${formatError(err)}`, code: 'read-failed' };
    }
  });

  ipcMain.handle('documents:list', async (_e, payload: { sessionId?: unknown; dirPath?: unknown }): Promise<DirListResult | DirListError> => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session', code: 'no-session' };

    const cwd = slot.cwd;
    if (!cwd) return { ok: false, error: 'No workspace directory', code: 'no-session' };

    const relDir = typeof payload?.dirPath === 'string' ? payload.dirPath : '';
    const absDir = relDir ? pathResolve(cwd, relDir) : cwd;

    const dirInCwd = isUnderCwd(absDir, cwd);
    if (!dirInCwd) {
      const allowed = await maybeAuthorizeExternal(absDir, absDir, slot.id, ctx);
      if (!allowed) {
        return { ok: false, error: 'Path is not inside the session workspace', code: 'not-in-cwd' };
      }
    }

    let realDir: string;
    try { realDir = await fs.realpath(absDir); } catch {
      return { ok: false, error: 'Directory not found', code: 'not-dir' };
    }
    let realCwd: string;
    try { realCwd = await fs.realpath(cwd); } catch { realCwd = cwd; }
    if (dirInCwd && !isUnderCwd(realDir, realCwd)) {
      console.warn(`[documents:list] symlink escape blocked: ${absDir} -> ${realDir}`);
      return { ok: false, error: 'Path is not inside the session workspace', code: 'not-in-cwd' };
    }

    try {
      const dirents = await fs.readdir(realDir, { withFileTypes: true });
      const entries: DirEntry[] = [];

      for (const d of dirents) {
        if (IGNORED_NAMES.has(d.name) || d.name.startsWith('.')) continue;
        const isDir = d.isDirectory();
        let size = 0;
        if (!isDir) {
          try {
            const s = await fs.stat(pathResolve(realDir, d.name));
            size = s.size;
          } catch { /* skip stat errors */ }
        }
        const ext = isDir ? '' : (extensionOf(d.name) ?? '');
        entries.push({ name: d.name, isDir, size, ext });
      }

      entries.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { ok: true, entries };
    } catch (err: unknown) {
      return { ok: false, error: `Read failed: ${formatError(err)}`, code: 'read-failed' };
    }
  });

  ipcMain.handle('documents:open-external', async (_e, payload: { sessionId?: unknown; path?: unknown }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    const cwd = slot.cwd;
    if (!cwd) return { ok: false, error: 'No workspace directory' };
    const rawPath = typeof payload?.path === 'string' ? payload.path : '';
    if (!rawPath) return { ok: false, error: 'Path required' };
    const absPath = isAbsolute(rawPath) ? rawPath : pathResolve(cwd, rawPath);
    const openInCwd = isUnderCwd(absPath, cwd);
    const artifactRoot = slot.orchestrator.getDeliveryArtifactRoot();
    const openInArtifacts = isUnderCwd(absPath, artifactRoot);
    if (!openInCwd && !openInArtifacts) {
      const allowed = await maybeAuthorizeExternal(absPath, dirname(absPath), slot.id, ctx);
      if (!allowed) return { ok: false, error: 'Path outside workspace' };
    }
    let realPath: string;
    try { realPath = await fs.realpath(absPath); } catch {
      return { ok: false, error: 'File not found' };
    }
    let realAllowedRoot: string;
    try { realAllowedRoot = await fs.realpath(openInArtifacts ? artifactRoot : cwd); } catch {
      realAllowedRoot = openInArtifacts ? artifactRoot : cwd;
    }
    if ((openInCwd || openInArtifacts) && !isUnderCwd(realPath, realAllowedRoot)) {
      return { ok: false, error: 'Path outside workspace' };
    }
    const err = await shell.openPath(realPath);
    if (err) return { ok: false, error: err };
    return { ok: true };
  });

  ipcMain.handle('session:steer-worker', (_e, payload: RawSteerPayload) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    const workerId = typeof payload?.workerId === 'string' ? payload.workerId : '';
    const addendum = typeof payload?.addendum === 'string' ? payload.addendum : '';
    if (!workerId) return { ok: false, error: 'Missing workerId' };
    if (!addendum.trim()) return { ok: false, error: 'Empty addendum' };
    const result = slot.orchestrator.steerWorker(workerId, addendum.trim());
    ctx.registry.touch(slot.id);
    if (!result.ok) {
      return { ok: false, error: `steer-worker failed: ${result.reason}`, reason: result.reason };
    }
    return { ok: true, queued: result.queued === true };
  });

  ipcMain.handle('session:interrupt-worker', async (_e, payload: { sessionId?: unknown; workerId?: unknown }) => {
    const slot = ctx.registry.resolve(pickSessionId(payload));
    if (!slot) return { ok: false, error: 'No active session' };
    const workerId = typeof payload?.workerId === 'string' ? payload.workerId : '';
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(workerId)) {
      return { ok: false, error: 'Invalid workerId' };
    }
    const result = await slot.orchestrator.interruptWorker(workerId);
    ctx.registry.touch(slot.id);
    return result;
  });
}
