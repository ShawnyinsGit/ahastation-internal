import { execFileSync } from 'node:child_process';
import { arch, release, totalmem } from 'node:os';
import { app, ipcMain, systemPreferences } from 'electron';
import { getSettings } from '../store.js';

export interface DeviceDiagnostics {
  capturedAt: number;
  platform: NodeJS.Platform;
  arch: string;
  kernel: string;
  totalMemoryBytes: number;
  electronVersion: string;
  sessionType: string;
  gpu: {
    available: boolean;
    status: Record<string, string>;
  };
  audio: {
    microphone: 'granted' | 'denied' | 'available' | 'unavailable' | 'unknown';
    speaker: 'available' | 'unknown';
    xfyun: boolean;
  };
  workspace: {
    git: boolean;
    worktree: boolean;
    version: string | null;
  };
  capacity: { hosts: number; workers: number };
}

function isXfyunAsrConfigured(): boolean {
  const c = getSettings().xfyunAsr;
  return Boolean(c?.appId?.trim() && c?.apiKey?.trim() && c?.apiSecret?.trim());
}

export function collectDeviceDiagnostics(): DeviceDiagnostics {
  let gitVersion: string | null = null;
  try {
    gitVersion = execFileSync('git', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
    }).trim();
  } catch { /* unavailable */ }

  let microphone: DeviceDiagnostics['audio']['microphone'] = 'unknown';
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    microphone = status === 'granted' ? 'granted' : status === 'denied' || status === 'restricted'
      ? 'denied'
      : 'unknown';
  } else if (process.platform === 'linux') {
    microphone = probeAlsa('arecord') ? 'available' : 'unavailable';
  }
  const speaker = process.platform === 'linux' && probeAlsa('aplay')
    ? 'available'
    : 'unknown';

  const gpuStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  const gpuAvailable = !Object.values(gpuStatus).every(
    (value) => value === 'disabled_software' || value === 'unavailable_software',
  );

  return {
    capturedAt: Date.now(),
    platform: process.platform,
    arch: arch(),
    kernel: release(),
    totalMemoryBytes: totalmem(),
    electronVersion: process.versions.electron ?? 'unknown',
    sessionType: process.env.XDG_SESSION_TYPE ?? (process.platform === 'linux' ? 'unknown' : 'native'),
    gpu: { available: gpuAvailable, status: gpuStatus },
    audio: {
      microphone,
      speaker,
      xfyun: isXfyunAsrConfigured(),
    },
    workspace: {
      git: Boolean(gitVersion),
      worktree: Boolean(gitVersion),
      version: gitVersion,
    },
    capacity: { hosts: 3, workers: 4 },
  };
}

function probeAlsa(binary: 'arecord' | 'aplay'): boolean {
  try {
    execFileSync(binary, ['-l'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function registerDeviceDiagnosticsIpc(): void {
  ipcMain.handle('device:diagnostics', async () => {
    try {
      return { ok: true, diagnostics: collectDeviceDiagnostics() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
