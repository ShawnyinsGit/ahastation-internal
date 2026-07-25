// companion-window-manager.ts — floating always-on-top BrowserWindow that
// hosts either the Phaser companion office (view=companion) or the Phase-1
// AhaBar + virtual keyboard (view=ahabar).
//
// Closing destroys the window (renderer sleeps). There is also show/hide for
// the AhaBar ghost mode so fullscreen demos can dim without tearing down the
// feed subscription.

import { BrowserWindow, app, nativeTheme, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type CompanionViewMode = 'ahabar' | 'companion';

const AHABAR_COMPACT = { width: 420, height: 56 };
const AHABAR_EXPANDED = { width: 420, height: 240 };
const COMPANION_SIZE = { width: 480, height: 320, minWidth: 360, minHeight: 240 };

let companionWin: BrowserWindow | null = null;
let currentView: CompanionViewMode = 'ahabar';

export function getCompanionWebContentsId(): number | null {
  return companionWin && !companionWin.isDestroyed() ? companionWin.webContents.id : null;
}

export function getCompanionViewMode(): CompanionViewMode {
  return currentView;
}

/** Is the floating window alive — optionally narrowed to one view mode. The
 *  minimize→AhaBar prompt keys off this to avoid offering a bar that's
 *  already on screen. */
export function isCompanionWindowOpen(view?: CompanionViewMode): boolean {
  if (!companionWin || companionWin.isDestroyed()) return false;
  return view ? currentView === view : true;
}

export function sendToCompanion(channel: string, payload: unknown): boolean {
  if (!companionWin || companionWin.isDestroyed()) return false;
  companionWin.webContents.send(channel, payload);
  return true;
}

export function closeCompanionWindow(): void {
  if (companionWin && !companionWin.isDestroyed()) {
    companionWin.close();
  }
}

export function focusMainWindow(getMain: () => BrowserWindow | null): boolean {
  const main = getMain();
  if (!main || main.isDestroyed()) return false;
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
  return true;
}

export function setAhaBarExpanded(expanded: boolean): boolean {
  if (!companionWin || companionWin.isDestroyed() || currentView !== 'ahabar') return false;
  const size = expanded ? AHABAR_EXPANDED : AHABAR_COMPACT;
  const [x, y] = companionWin.getPosition();
  companionWin.setBounds({ x, y, width: size.width, height: size.height }, true);
  return true;
}

export function setAhaBarGhost(ghost: boolean): boolean {
  if (!companionWin || companionWin.isDestroyed()) return false;
  companionWin.setOpacity(ghost ? 0.35 : 1);
  return true;
}

/** Toggle the floating window. Phase 1 defaults to AhaBar; pass `companion`
 *  to reopen the Phaser office (still available for later). */
export function toggleCompanionWindow(view: CompanionViewMode = 'ahabar'): { open: boolean } {
  if (companionWin && !companionWin.isDestroyed()) {
    if (currentView === view) {
      companionWin.close();
      return { open: false };
    }
    companionWin.close();
  }
  companionWin = createCompanionWindow(view);
  return { open: true };
}

function createCompanionWindow(view: CompanionViewMode): BrowserWindow {
  const dev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;
  currentView = view;

  const isAha = view === 'ahabar';
  const size = isAha ? AHABAR_COMPACT : COMPANION_SIZE;
  const display = screen.getPrimaryDisplay().workArea;

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: Math.round(display.x + (display.width - size.width) / 2),
    y: Math.round(display.y + (isAha ? 12 : 48)),
    minWidth: isAha ? 320 : COMPANION_SIZE.minWidth,
    minHeight: isAha ? 48 : COMPANION_SIZE.minHeight,
    title: isAha ? 'AhaBar' : 'AhaStation 陪伴屏',
    frame: false,
    alwaysOnTop: true,
    resizable: !isAha,
    skipTaskbar: isAha,
    transparent: isAha,
    backgroundColor: isAha
      ? '#00000000'
      : (nativeTheme.shouldUseDarkColors ? '#141416' : '#f2f2f7'),
    webPreferences: {
      // NB: this file compiles to dist-electron/companion/ — preload is one
      // level up, dist bundle two levels up.
      preload: join(__dirname, '..', 'preload-companion.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'companion',
    },
  });

  if (isAha) {
    win.setAlwaysOnTop(true, 'floating');
  }

  // Tight CSP (same shape as the editor window): self-only, no localhost
  // wildcard, no eval — Phaser renders to canvas, no WASM needed.
  const devOrigin = dev ? new URL(process.env.VITE_DEV_SERVER_URL!).origin : '';
  const devWsOrigin = dev ? devOrigin.replace(/^http/, 'ws') : '';
  const csp = dev
    ? [
        `default-src 'self' ${devOrigin}`,
        `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${devOrigin}`,
        `style-src 'self' 'unsafe-inline' ${devOrigin}`,
        `img-src 'self' data: blob: ${devOrigin}`,
        `font-src 'self' data: ${devOrigin}`,
        `connect-src 'self' ${devOrigin} ${devWsOrigin}`,
        `worker-src 'self' blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        `script-src 'self'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `font-src 'self' data:`,
        `connect-src 'self'`,
        `worker-src 'self' blob:`,
        `object-src 'none'`,
        `base-uri 'self'`,
      ].join('; ');

  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });

  win.on('closed', () => {
    companionWin = null;
  });

  const query = new URLSearchParams({ view });
  if (dev) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${query.toString()}`);
  } else {
    win.loadFile(join(__dirname, '..', '..', 'dist', 'index.html'), {
      query: Object.fromEntries(query),
    });
  }
  return win;
}
