// companion-window-manager.ts — the companion-screen BrowserWindow
// (Phase 8, §3.4 触发矩阵: manual desktop entry + floating form factor).
//
// Small frameless always-on-top floating window with its own in-memory
// session partition and the same tight CSP shape as the editor window (no
// localhost wildcard, no eval). Closing the window stops all rendering —
// the renderer sleeps its Phaser loop and main drops the reference here.

import { BrowserWindow, app, nativeTheme } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let companionWin: BrowserWindow | null = null;

export function getCompanionWebContentsId(): number | null {
  return companionWin && !companionWin.isDestroyed() ? companionWin.webContents.id : null;
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

export function toggleCompanionWindow(): { open: boolean } {
  if (companionWin && !companionWin.isDestroyed()) {
    companionWin.close();
    return { open: false };
  }
  companionWin = createCompanionWindow();
  return { open: true };
}

function createCompanionWindow(): BrowserWindow {
  const dev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

  const win = new BrowserWindow({
    width: 480,
    height: 320,
    minWidth: 360,
    minHeight: 240,
    title: 'AhaMeet 陪伴屏',
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141416' : '#f2f2f7',
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

  const query = new URLSearchParams({ view: 'companion' });
  if (dev) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${query.toString()}`);
  } else {
    win.loadFile(join(__dirname, '..', '..', 'dist', 'index.html'), {
      query: Object.fromEntries(query),
    });
  }
  return win;
}
