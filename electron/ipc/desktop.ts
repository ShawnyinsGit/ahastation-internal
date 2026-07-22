import { ipcMain, app, desktopCapturer, systemPreferences, shell, session } from 'electron';
import * as os from 'os';
import { errorMessage } from '../format-error.js';
import { requestMicrophoneAccess } from '../microphone-access.js';

function isMacOS14Plus(): boolean {
  if (process.platform !== 'darwin') return false;
  // Darwin 23 = macOS 14 Sonoma
  const major = parseInt(os.release().split('.')[0], 10);
  return major >= 23;
}

export function registerDesktopIpc(): void {
  // macOS 14+: register the system picker so renderer can use getDisplayMedia()
  // and the OS-native ScreenCaptureKit picker appears (enumerates fullscreen windows).
  // Deferred to app.whenReady because session.defaultSession is only available
  // after the app is ready — accessing it at module-load time throws.
  if (isMacOS14Plus()) {
    app.whenReady().then(() => {
      session.defaultSession.setDisplayMediaRequestHandler(
        (_request, callback) => {
          callback({ video: undefined as any });
        },
        { useSystemPicker: true },
      );
    });
  }

  ipcMain.handle('desktop:use-system-picker', () => isMacOS14Plus());

  // Current app version for the settings page + update banner.
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('desktop:get-sources', async () => {
    try {
      const status = process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : 'granted';
      if (status !== 'granted') {
        // Not-determined needs special handling on macOS: calling getSources
        // is what registers AhaMeet in the Screen Recording list under System
        // Settings, so we still fire it (best-effort, ignore the result) before
        // returning. Without that ping, AhaMeet won't appear for the user to
        // toggle on. The OS may also raise its own prompt at this point.
        if (status === 'not-determined') {
          desktopCapturer
            .getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } })
            .catch(() => { /* expected — perm prompt is the point */ });
        }
        return { ok: false, error: 'permission-needed', status };
      }
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 240, height: 140 },
        fetchWindowIcons: false,
      });
      return {
        ok: true,
        sources: sources.map((s) => ({
          id: s.id,
          name: s.name,
          thumbnail: s.thumbnail.toDataURL(),
        })),
      };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err), status: 'unknown' };
    }
  });

  // One-click relaunch after the user grants Screen Recording in System
  // Settings. macOS only applies new screen-capture permissions to processes
  // that start *after* the grant, so the running AhaMeet keeps seeing 'denied'
  // until we restart.
  ipcMain.handle('app:relaunch', async () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('desktop:check-permission', async () => {
    if (process.platform !== 'darwin') return 'granted';
    const status = systemPreferences.getMediaAccessStatus('screen');
    return status;
  });

  ipcMain.handle('desktop:open-settings', async () => {
    if (process.platform !== 'darwin') return { ok: false };
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { ok: true };
  });

  ipcMain.handle('mic:request-permission', async () => {
    return requestMicrophoneAccess(true);
  });
}
