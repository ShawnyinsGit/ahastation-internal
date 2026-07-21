// opencode-window-manager.ts — manages independent OpenCode editor windows.
//
// Each digital employee (CLI backend participant) can have its own editor
// window. Windows are keyed by hostId — NOT backendId:sessionId. The old
// composite key collided whenever two participants in the same meeting ran
// the same backend (e.g. two OpenCode workers share backendId + meeting tab
// sessionId), which made the second editor window impossible to open.

import { BrowserWindow, app, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface OpenCodeEditorWindowOptions {
  hostId: string;
  backendId: string;
  sessionId: string;
  cwd: string;
  title?: string;
}

export interface EditorWindowEntry {
  win: BrowserWindow;
  options: OpenCodeEditorWindowOptions;
}

const editorWindows = new Map<string, EditorWindowEntry>();

function getThemeBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7';
}

/** Primary key for editor windows. Exported as a pure function so tests can
 *  pin the uniqueness contract without instantiating BrowserWindow. */
export function editorWindowKey(hostId: string): string {
  return hostId;
}

/** Reverse lookup used by the ide-files IPC: given the webContents id of an
 *  IPC sender, return the editor window entry it belongs to (or null when the
 *  sender is not a registered editor window). */
export function getEditorEntryByWebContentsId(id: number): EditorWindowEntry | null {
  for (const entry of editorWindows.values()) {
    if (!entry.win.isDestroyed() && entry.win.webContents.id === id) {
      return entry;
    }
  }
  return null;
}

export function createOpenCodeEditorWindow(options: OpenCodeEditorWindowOptions): BrowserWindow {
  const key = editorWindowKey(options.hostId);
  const existing = editorWindows.get(key);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return existing.win;
  }

  const dev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: options.title ?? `OpenCode - ${options.hostId}`,
    backgroundColor: getThemeBackgroundColor(),
    transparent: false,
    titleBarStyle: 'default',
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Dedicated in-memory session so this window's CSP handler does NOT
      // overwrite the default-session handler shared by the main / popout /
      // settings windows (their conflicting handlers are a separate known
      // issue, intentionally untouched here).
      partition: 'opencode-editor',
    },
  });

  const entry: EditorWindowEntry = { win, options };
  editorWindows.set(key, entry);

  win.on('closed', () => {
    editorWindows.delete(key);
  });

  // CSP injection. Dev keeps the vite origin + HMR websocket; prod is fully
  // self-contained. No `http://localhost:*` connect-src wildcard in either
  // mode, and no eval tokens in prod — the editor view runs neither the
  // ONNX/VAD stack nor any eval-based tooling, so the eval surface is free
  // to give up.
  const devOrigin = dev ? new URL(process.env.VITE_DEV_SERVER_URL!).origin : '';
  const devWsOrigin = dev ? devOrigin.replace(/^http/, 'ws') : '';
  const csp = dev
    ? [
        `default-src 'self' ${devOrigin}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}`,
        `style-src 'self' 'unsafe-inline' ${devOrigin}`,
        `img-src 'self' data: blob: ${devOrigin}`,
        `media-src 'self' blob: data: ${devOrigin}`,
        `font-src 'self' data: ${devOrigin}`,
        `connect-src 'self' ${devOrigin} ${devWsOrigin}`,
        `worker-src 'self' blob:`,
        `frame-src blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        `script-src 'self'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `media-src 'self' blob: data:`,
        `font-src 'self' data:`,
        `connect-src 'self'`,
        `worker-src 'self' blob:`,
        `frame-src blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ');

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      },
    });
  });

  // Load the editor UI with query params so the renderer knows which
  // host/backend/session to display.
  const query = new URLSearchParams({
    view: 'opencode-editor',
    hostId: options.hostId,
    backendId: options.backendId,
    sessionId: options.sessionId,
    cwd: options.cwd,
  });

  if (dev) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${query.toString()}`);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(join(__dirname, '..', 'dist', 'index.html'), { query: Object.fromEntries(query) });
  }

  return win;
}

export function closeOpenCodeEditorWindow(hostId: string): void {
  const key = editorWindowKey(hostId);
  const entry = editorWindows.get(key);
  if (entry && !entry.win.isDestroyed()) {
    entry.win.close();
  }
}

export function listOpenCodeEditorWindows(): Array<{
  hostId: string;
  backendId: string;
  sessionId: string;
  focused: boolean;
}> {
  const result: Array<{ hostId: string; backendId: string; sessionId: string; focused: boolean }> = [];
  for (const entry of editorWindows.values()) {
    if (!entry.win.isDestroyed()) {
      result.push({
        hostId: entry.options.hostId,
        backendId: entry.options.backendId,
        sessionId: entry.options.sessionId,
        focused: entry.win.isFocused(),
      });
    }
  }
  return result;
}
