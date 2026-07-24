import { ipcMain, shell } from 'electron';
import { getSettings, updateSettings, clearVoicePrint, type AsrProvider, type CloudAsrSettings, type Settings, type VoicePrint } from '../store.js';
import { DEFAULT_CLOUD_ASR_MODEL } from '../cloud-asr.js';

export interface VoicePrefPatch {
  selectedVoiceName?: string | null;
  guidanceDismissed?: boolean;
  speechFilterMode?: 'strict' | 'off';
  voicePolishEnabled?: boolean;
  reportModeEnabled?: boolean;
  handheldMode?: 'auto' | 'handheld' | 'desktop';
  asrProvider?: AsrProvider;
  cloudAsr?: CloudAsrSettings;
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
  if (Object.prototype.hasOwnProperty.call(patch, 'asrProvider')) {
    if (patch.asrProvider !== 'local' && patch.asrProvider !== 'cloud') {
      return { ok: false, error: `invalid asrProvider: ${String(patch.asrProvider)}` };
    }
    next.asrProvider = patch.asrProvider;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'cloudAsr')) {
    const c = patch.cloudAsr;
    if (typeof c !== 'object' || c === null) {
      return { ok: false, error: 'cloudAsr must be an object' };
    }
    for (const key of ['baseUrl', 'apiKey', 'model'] as const) {
      if (c[key] !== undefined && typeof c[key] !== 'string') {
        return { ok: false, error: `cloudAsr.${key} must be a string` };
      }
    }
    const cleaned: CloudAsrSettings = {};
    if (typeof c.baseUrl === 'string') cleaned.baseUrl = c.baseUrl.trim();
    if (typeof c.apiKey === 'string') cleaned.apiKey = c.apiKey.trim();
    if (typeof c.model === 'string') cleaned.model = c.model.trim();
    next.cloudAsr = cleaned;
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
      asrProvider: s.asrProvider ?? 'local',
      cloudAsr: {
        baseUrl: s.cloudAsr?.baseUrl ?? '',
        apiKey: s.cloudAsr?.apiKey ?? '',
        model: s.cloudAsr?.model ?? DEFAULT_CLOUD_ASR_MODEL,
      },
    };
  });

  ipcMain.handle('settings:set-voice-pref', async (_e, patch: VoicePrefPatch) => {
    const result = buildVoicePrefUpdate(patch);
    if (!result.ok) return { ok: false, error: result.error };
    const next = result.next;
    // cloudAsr arrives as a partial — merge onto the stored entry so the
    // renderer can update one field without resending the apiKey.
    if (next.cloudAsr) {
      next.cloudAsr = { ...(getSettings().cloudAsr ?? {}), ...next.cloudAsr };
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
