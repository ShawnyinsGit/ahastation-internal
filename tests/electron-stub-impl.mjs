// Minimal stub of the parts of `electron` that the orchestrator's transitive
// imports touch at module load time. The test never reaches code that calls
// these — they exist only so `import { app } from 'electron'` resolves.

export const app = {
  getPath: () => '/tmp',
  isPackaged: false,
};
export const ipcMain = { handle: () => {}, on: () => {} };
export const desktopCapturer = {};
export const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
};
export const shell = { openExternal: async () => {} };
export const dialog = { showMessageBox: async () => ({ response: 1 }) };
export const BrowserWindow = class {
  static getFocusedWindow() { return null; }
};
export const safeStorage = { encryptString: () => Buffer.alloc(0), decryptString: () => '' };
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };
export const nativeTheme = { shouldUseDarkColors: false, on: () => {} };

export default { app, ipcMain, dialog, desktopCapturer, systemPreferences, shell, BrowserWindow, safeStorage, screen, nativeTheme };
