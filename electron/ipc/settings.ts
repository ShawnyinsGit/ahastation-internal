import { ipcMain, shell } from 'electron';
import { getSettings, updateSettings, clearVoicePrint, type VoicePrint } from '../store.js';

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get-voice-config', async () => {
    const s = getSettings();
    return {
      enabled: Boolean(s.voiceLockEnabled),
      voicePrint: s.voicePrint ?? null,
    };
  });

  ipcMain.handle('settings:set-voice-lock-enabled', async (_e, enabled: boolean) => {
    await updateSettings({ voiceLockEnabled: !!enabled });
    return { ok: true };
  });

  ipcMain.handle('settings:set-voice-print', async (_e, vp: VoicePrint | null) => {
    if (!vp) {
      await clearVoicePrint();
    } else {
      await updateSettings({ voicePrint: vp });
    }
    return { ok: true };
  });

  ipcMain.handle('settings:get-voice-pref', async () => {
    const s = getSettings();
    return {
      selectedVoiceName: s.selectedVoiceName ?? null,
      guidanceDismissed: Boolean(s.voiceGuidanceDismissed),
      speechFilterMode: s.speechFilterMode ?? 'strict',
      voicePolishEnabled: Boolean(s.voicePolishEnabled),
      reportModeEnabled: Boolean(s.reportModeEnabled),
      handheldMode: s.handheldMode ?? 'auto',
    };
  });

  ipcMain.handle('settings:set-voice-pref', async (
    _e,
    patch: { selectedVoiceName?: string | null; guidanceDismissed?: boolean; speechFilterMode?: 'strict' | 'off'; voicePolishEnabled?: boolean; reportModeEnabled?: boolean; handheldMode?: 'auto' | 'handheld' | 'desktop' },
  ) => {
    const next: Partial<{ selectedVoiceName: string | null; voiceGuidanceDismissed: boolean; speechFilterMode: 'strict' | 'off'; voicePolishEnabled: boolean; reportModeEnabled: boolean; handheldMode: 'auto' | 'handheld' | 'desktop' }> = {};
    if (Object.prototype.hasOwnProperty.call(patch, 'selectedVoiceName')) {
      next.selectedVoiceName = patch.selectedVoiceName ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'guidanceDismissed')) {
      next.voiceGuidanceDismissed = Boolean(patch.guidanceDismissed);
    }
    if (patch.speechFilterMode === 'strict' || patch.speechFilterMode === 'off') {
      next.speechFilterMode = patch.speechFilterMode;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'voicePolishEnabled')) {
      next.voicePolishEnabled = Boolean(patch.voicePolishEnabled);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'reportModeEnabled')) {
      next.reportModeEnabled = Boolean(patch.reportModeEnabled);
    }
    if (patch.handheldMode === 'auto' || patch.handheldMode === 'handheld' || patch.handheldMode === 'desktop') {
      next.handheldMode = patch.handheldMode;
    }
    await updateSettings(next);
    return { ok: true };
  });

  // Deep-link into System Settings → Accessibility → Spoken Content so the
  // user can install the higher-quality Siri / Premium / Enhanced Chinese
  // voices. Apple gives us no API to trigger the download programmatically;
  // this is the closest we get to one click.
  ipcMain.handle('system:open-voice-settings', async () => {
    if (process.platform !== 'darwin') return { ok: false };
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.universalaccess?Speech');
    return { ok: true };
  });
}
