// ide-window-manager.ts — manages independent editor windows (IDE-agnostic).
//
// Each digital employee (CLI backend participant) can have its own editor
// window. Windows are keyed by hostId — NOT backendId:sessionId. The old
// composite key collided whenever two participants in the same meeting ran
// the same backend (e.g. two OpenCode workers share backendId + meeting tab
// sessionId), which made the second editor window impossible to open.

import { BrowserWindow, app, nativeTheme, screen, webContents } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings } from '../store.js';
import {
  NO_EDITOR_CAPABILITIES,
  serializeEditorCapabilities,
  type EditorIdeCapabilities,
} from './ide-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface EditorWindowOptions {
  hostId: string;
  backendId: string;
  sessionId: string;
  cwd: string;
  title?: string;
  /** UI-relevant capability set of the attaching IDE adapter — serialized
   *  into the window query so the renderer hides panels it can't use. */
  capabilities?: EditorIdeCapabilities;
}

export interface EditorWindowEntry {
  win: BrowserWindow;
  options: EditorWindowOptions;
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

// ── Editor overlay binding (Phase 6a) ──────────────────────────────────────
// In handheld mode the editor UI runs INSIDE the main window's renderer as a
// full-screen overlay (App subtree stays mounted — voice hooks survive). The
// overlay registers its (hostId, sessionId, cwd) here against the MAIN
// window's webContents so the exact same ide-files / ide-editor:get-state /
// ide-pty channels and the point-to-point fan-out work unchanged — the
// channels resolve context from this binding, never from renderer payloads.

export interface EditorContext {
  hostId: string;
  sessionId: string;
  cwd: string;
}

interface OverlayBinding extends EditorContext {
  webContentsId: number;
}

let activeOverlay: OverlayBinding | null = null;

export function setEditorOverlayBinding(binding: OverlayBinding | null): void {
  activeOverlay = binding;
}

export function getEditorOverlayBinding(): OverlayBinding | null {
  return activeOverlay;
}

/** Resolve the editor context (hostId/sessionId/cwd) for ANY editor-capable
 *  sender: the overlay binding first (main window hosting the overlay),
 *  then registered independent editor windows. */
export function resolveEditorContextByWebContentsId(id: number): EditorContext | null {
  if (activeOverlay && activeOverlay.webContentsId === id) {
    return {
      hostId: activeOverlay.hostId,
      sessionId: activeOverlay.sessionId,
      cwd: activeOverlay.cwd,
    };
  }
  const entry = getEditorEntryByWebContentsId(id);
  if (!entry) return null;
  return {
    hostId: entry.options.hostId,
    sessionId: entry.options.sessionId,
    cwd: entry.options.cwd,
  };
}

// ── hostId ↔ opencode session binding + event fan-out (§2.2 rule 7) ────────
// One binding table, co-located with the window registry (no third table):
// the adapter binds (hostId → opencode sessionID) once its session exists —
// possibly before any editor window is open — and unbinds on end(). Window
// close only drops the window entry; the binding survives for re-attach.

const sessionBindings = new Map<string, string>();

export function bindEditorSession(hostId: string, opencodeSessionId: string): void {
  sessionBindings.set(hostId, opencodeSessionId);
}

export function unbindEditorSession(hostId: string): void {
  sessionBindings.delete(hostId);
}

export function getBoundOpenCodeSessionId(hostId: string): string | null {
  return sessionBindings.get(hostId) ?? null;
}

/** Point-to-point fan-out: send the payload ONLY to the editor surface
 *  registered for this hostId — the overlay binding (main window) when it
 *  matches, otherwise the independent editor window (never a
 *  getAllWindows() broadcast). When no live surface exists the event stays
 *  in main (the adapter keeps the snapshot; a re-attached surface pulls it
 *  via ide-editor:get-state). Returns whether a live surface received it. */
export function forwardToEditorWindow(hostId: string, payload: unknown): boolean {
  if (activeOverlay && activeOverlay.hostId === hostId) {
    const wc = webContents.fromId(activeOverlay.webContentsId);
    if (wc && !wc.isDestroyed()) {
      wc.send('ide-editor:event', { hostId, payload });
      return true;
    }
  }
  const entry = editorWindows.get(editorWindowKey(hostId));
  if (!entry || entry.win.isDestroyed()) return false;
  entry.win.webContents.send('ide-editor:event', { hostId, payload });
  return true;
}

// ── Window-closed listeners (PTY cleanup etc.) ─────────────────────────────

export type EditorWindowClosedListener = (hostId: string, webContentsId: number) => void;

const closedListeners = new Set<EditorWindowClosedListener>();

export function onEditorWindowClosed(cb: EditorWindowClosedListener): () => void {
  closedListeners.add(cb);
  return () => { closedListeners.delete(cb); };
}

export function createEditorWindow(options: EditorWindowOptions): BrowserWindow {
  const key = editorWindowKey(options.hostId);
  const existing = editorWindows.get(key);
  if (existing && !existing.win.isDestroyed()) {
    existing.win.focus();
    return existing.win;
  }

  const dev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

  // Default to the usable work area (never larger); maximize in handheld
  // mode (forced, or auto on a small screen — pointer can't be probed from
  // main, so width is the proxy). Deliberately NO minWidth (§3.3).
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const handheldPref = getSettings().handheldMode ?? 'auto';
  const handheldish = handheldPref === 'handheld'
    || (handheldPref === 'auto' && workArea.width <= 1300);

  const win = new BrowserWindow({
    width: Math.min(1200, workArea.width),
    height: Math.min(800, workArea.height),
    title: options.title ?? `Editor - ${options.hostId}`,
    backgroundColor: getThemeBackgroundColor(),
    transparent: false,
    titleBarStyle: 'default',
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    webPreferences: {
      // Narrow preload (editor view only needs ideFiles/ideSession) — the
      // full meeting control surface in preload.cjs stays exclusive to the
      // main / settings / popout windows. NB: this file lives in
      // dist-electron/ide/, so the preload is one level up.
      preload: join(__dirname, '..', 'preload-editor.cjs'),
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

  if (handheldish) {
    win.maximize();
  }

  win.on('closed', () => {
    editorWindows.delete(key);
    for (const cb of closedListeners) {
      try {
        cb(key, win.webContents.id);
      } catch (err) {
        console.warn('[ide-window-manager] closed listener failed:', err);
      }
    }
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
        // 'wasm-unsafe-eval' is for shiki's oniguruma WASM engine (Phase 4
        // syntax highlighting). Deliberately narrower than the old
        // 'unsafe-eval': it permits WASM compilation only, not JS eval.
        `script-src 'self' 'wasm-unsafe-eval'`,
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
  // host/backend/session to display and which panels its IDE supports.
  // (The `view=opencode-editor` value is frozen surface — v1.2 churn control.)
  const query = new URLSearchParams({
    view: 'opencode-editor',
    hostId: options.hostId,
    backendId: options.backendId,
    sessionId: options.sessionId,
    cwd: options.cwd,
    caps: serializeEditorCapabilities(options.capabilities ?? NO_EDITOR_CAPABILITIES),
  });

  if (dev) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${query.toString()}`);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // NB: this file lives in dist-electron/ide/ — dist/ is two levels up.
    win.loadFile(join(__dirname, '..', '..', 'dist', 'index.html'), { query: Object.fromEntries(query) });
  }

  return win;
}

export function closeEditorWindow(hostId: string): void {
  const key = editorWindowKey(hostId);
  const entry = editorWindows.get(key);
  if (entry && !entry.win.isDestroyed()) {
    entry.win.close();
  }
}

export function listEditorWindows(): Array<{
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
