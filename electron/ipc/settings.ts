import { ipcMain, shell, webContents } from 'electron';
import { getSettings, updateSettings, clearVoicePrint, type Settings, type VoicePrint, type XfyunAsrCredentials } from '../store.js';

export interface VoicePrefPatch {
  selectedVoiceName?: string | null;
  guidanceDismissed?: boolean;
  speechFilterMode?: 'strict' | 'off';
  voicePolishEnabled?: boolean;
  reportModeEnabled?: boolean;
  handheldMode?: 'auto' | 'handheld' | 'desktop';
  xfyunAsr?: XfyunAsrCredentials;
}

// Pure validation/mapping for the settings:set-voice-pref payload. Exported
// so node:test can drive it without booting electron. Unknown enum values
// and wrong-typed fields are rejected with an error instead of being
// silently dropped (a renderer bug used to pass a boolean for an enum field
// and the write vanished without a trace).
export function buildVoicePrefUpdate(
  patch: VoicePrefPatch,
): { ok: true; next: Partial<Settings> } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null) {
    return { ok: false, error: 'voice pref patch must be an object' };
  }
  const next: Partial<Settings> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'selectedVoiceName')) {
    if (patch.selectedVoiceName !== null && typeof patch.selectedVoiceName !== 'string') {
      return { ok: false, error: 'selectedVoiceName must be a string or null' };
    }
    next.selectedVoiceName = patch.selectedVoiceName ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'guidanceDismissed')) {
    if (typeof patch.guidanceDismissed !== 'boolean') {
      return { ok: false, error: 'guidanceDismissed must be a boolean' };
    }
    next.voiceGuidanceDismissed = patch.guidanceDismissed;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'speechFilterMode')) {
    if (patch.speechFilterMode !== 'strict' && patch.speechFilterMode !== 'off') {
      return { ok: false, error: `invalid speechFilterMode: ${String(patch.speechFilterMode)}` };
    }
    next.speechFilterMode = patch.speechFilterMode;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'voicePolishEnabled')) {
    if (typeof patch.voicePolishEnabled !== 'boolean') {
      return { ok: false, error: 'voicePolishEnabled must be a boolean' };
    }
    next.voicePolishEnabled = patch.voicePolishEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'reportModeEnabled')) {
    if (typeof patch.reportModeEnabled !== 'boolean') {
      return { ok: false, error: 'reportModeEnabled must be a boolean' };
    }
    next.reportModeEnabled = patch.reportModeEnabled;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'handheldMode')) {
    if (patch.handheldMode !== 'auto' && patch.handheldMode !== 'handheld' && patch.handheldMode !== 'desktop') {
      return { ok: false, error: `invalid handheldMode: ${String(patch.handheldMode)}` };
    }
    next.handheldMode = patch.handheldMode;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'xfyunAsr')) {
    const c = patch.xfyunAsr;
    if (typeof c !== 'object' || c === null) {
      return { ok: false, error: 'xfyunAsr must be an object' };
    }
    for (const key of ['appId', 'apiKey', 'apiSecret'] as const) {
      if (c[key] !== undefined && typeof c[key] !== 'string') {
        return { ok: false, error: `xfyunAsr.${key} must be a string` };
      }
    }
    const cleaned: XfyunAsrCredentials = {};
    if (typeof c.appId === 'string') cleaned.appId = c.appId.trim();
    if (typeof c.apiKey === 'string') cleaned.apiKey = c.apiKey.trim();
    if (typeof c.apiSecret === 'string') cleaned.apiSecret = c.apiSecret.trim();
    next.xfyunAsr = cleaned;
  }
  return { ok: true, next };
}

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
      xfyunAsr: {
        appId: s.xfyunAsr?.appId ?? '',
        apiKey: s.xfyunAsr?.apiKey ?? '',
        apiSecret: s.xfyunAsr?.apiSecret ?? '',
      },
    };
  });

  ipcMain.handle('settings:set-voice-pref', async (_e, patch: VoicePrefPatch) => {
    const result = buildVoicePrefUpdate(patch);
    if (!result.ok) return { ok: false, error: result.error };
    const next = result.next;
    // xfyunAsr arrives as a partial — merge onto the stored entry so the
    // renderer can update one field without resending secrets.
    if (next.xfyunAsr) {
      next.xfyunAsr = { ...(getSettings().xfyunAsr ?? {}), ...next.xfyunAsr };
    }
    await updateSettings(next);
    // ASR availability is probed once at renderer mount; when credentials
    // change mid-session, notify every window so hooks re-probe instead of
    // requiring an app restart for the mic to unlock.
    if (next.xfyunAsr) {
      for (const wc of webContents.getAllWebContents()) {
        wc.send('settings:voice-pref-changed');
      }
    }
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
