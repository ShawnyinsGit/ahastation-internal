import { BrowserWindow, dialog, shell, systemPreferences } from 'electron';

export type MicrophoneAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export interface MicrophoneAccessDeps {
  platform: NodeJS.Platform;
  getStatus: () => MicrophoneAccessStatus;
  askForAccess: () => Promise<boolean>;
  showDeniedHelp: () => Promise<boolean>;
  openSettings: () => Promise<void>;
}

/** Testable macOS microphone permission state machine. The OS only shows its
 * consent sheet for `not-determined`; a previous denial must be recovered via
 * System Settings instead of repeatedly calling askForMediaAccess(). */
export async function ensureMicrophoneAccess(
  deps: MicrophoneAccessDeps,
  offerSettings: boolean,
): Promise<boolean> {
  if (deps.platform !== 'darwin') return true;
  const status = deps.getStatus();
  if (status === 'granted') return true;
  if (status === 'not-determined' || status === 'unknown') {
    const granted = await deps.askForAccess();
    if (granted || !offerSettings) return granted;
  } else if (!offerSettings) {
    return false;
  }
  if (await deps.showDeniedHelp()) await deps.openSettings();
  return false;
}

let requestInFlight: Promise<boolean> | null = null;
let inFlightOffersSettings = false;

/** Shared entry point for launch-time and renderer-triggered requests. The
 * in-flight guard prevents two simultaneous native permission sheets when the
 * UI enables voice while the first-launch check is still resolving. */
export function requestMicrophoneAccess(offerSettings = false): Promise<boolean> {
  if (requestInFlight) {
    const current = requestInFlight;
    if (!offerSettings || inFlightOffersSettings) return current;
    // A launch-time request may overlap the renderer enabling voice. If the
    // OS request is denied, retry through the recovery path so the renderer's
    // stronger request still gets the native “Open System Settings” dialog.
    return current.then((granted) => granted ? true : requestMicrophoneAccess(true));
  }
  inFlightOffersSettings = offerSettings;
  requestInFlight = ensureMicrophoneAccess({
    platform: process.platform,
    getStatus: () => systemPreferences.getMediaAccessStatus('microphone') as MicrophoneAccessStatus,
    askForAccess: () => systemPreferences.askForMediaAccess('microphone'),
    showDeniedHelp: async () => {
      const parent = BrowserWindow.getFocusedWindow();
      const options = {
        type: 'warning' as const,
        title: '需要麦克风权限',
        message: 'AhaStation 无法访问麦克风',
        detail: '请在“系统设置 → 隐私与安全性 → 麦克风”中允许 AhaStation，然后重新开启语音。',
        buttons: ['打开系统设置', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const result = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    },
    openSettings: async () => {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    },
  }, offerSettings).finally(() => {
    requestInFlight = null;
    inFlightOffersSettings = false;
  });
  return requestInFlight;
}
