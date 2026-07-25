// useRemoteVoiceLock — settings-window counterpart to useVoiceLock.
//
// The mic/VAD/embedding pipeline only exists in the main window's App, so
// the settings window cannot enroll locally (its own useVoiceLock instance
// used to set enrollment state that no capture ever fed — the panel sat at
// "等待麦克风启动…" forever). This hook drives the VoiceLockPanel entirely
// over the enrollment bridge:
//   start/cancel -> IPC -> main window's useVoiceLock
//   progress     <- IPC <- broadcast from the main window's App
// Voice config (voiceprint / lock toggle) reads and writes go through the
// shared settings store; 'voiceconfig:changed' keeps both windows in sync.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnrollmentToast } from '../components/VoiceLockPanel';
import type { VoiceLockEnrollState, VoicePrint } from '../types';

const ENROLLMENT_TARGET_SECONDS = 8;

interface RemoteEnrollmentProgress {
  targetSeconds: number;
  capturedSeconds: number;
  segments: number;
}

export function useRemoteVoiceLock() {
  const [voiceLockEnabled, setVoiceLockEnabled] = useState(false);
  const [voicePrint, setVoicePrint] = useState<VoicePrint | null>(null);
  const [enrollment, setEnrollment] = useState<RemoteEnrollmentProgress | null>(null);
  const [enrollmentToast, setEnrollmentToast] = useState<EnrollmentToast>(null);
  const toastTimerRef = useRef<number | null>(null);

  const refresh = useCallback(() => {
    window.vibeMeet.getVoiceConfig().then(({ enabled, voicePrint: vp }) => {
      setVoiceLockEnabled(enabled);
      setVoicePrint(vp);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const unsubscribe = window.vibeMeet.onVoiceConfigChanged?.(() => refresh());
    return () => {
      unsubscribe?.();
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    };
  }, [refresh]);

  const showToast = useCallback((kind: Exclude<EnrollmentToast, null>) => {
    setEnrollmentToast(kind);
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      setEnrollmentToast(null);
      toastTimerRef.current = null;
    }, 3500);
  }, []);

  // Progress stream from the main window's enrollment run.
  useEffect(() => {
    return window.vibeMeet.onVoiceLockEnrollState?.((state: VoiceLockEnrollState) => {
      setEnrollment(state.enrollment);
      if (state.toast) showToast(state.toast);
    });
  }, [showToast]);

  const handleStartEnrollment = useCallback(() => {
    // Optimistic: show the recording UI immediately; real progress replaces
    // it on the first broadcast. If no main window is listening, the panel
    // stays at "等待麦克风启动…" — the hint tells the user to open it.
    setEnrollment({ targetSeconds: ENROLLMENT_TARGET_SECONDS, capturedSeconds: 0, segments: 0 });
    setEnrollmentToast(null);
    void window.vibeMeet.voiceLockEnrollStart();
  }, []);

  const handleCancelEnrollment = useCallback(() => {
    void window.vibeMeet.voiceLockEnrollCancel();
    // The main window's broadcast ends the recording UI; if it never comes
    // (main window closed), clear locally so the panel isn't stuck.
    window.setTimeout(() => {
      setEnrollment((prev) => (prev && prev.capturedSeconds === 0 && prev.segments === 0 ? null : prev));
    }, 1500);
  }, []);

  const handleToggleVoiceLock = useCallback(() => {
    setVoiceLockEnabled((prev) => {
      const next = !prev;
      void window.vibeMeet.setVoiceLockEnabled(next);
      return next;
    });
  }, []);

  const handleClearEnrollment = useCallback(() => {
    setVoicePrint(null);
    setVoiceLockEnabled(false);
    void window.vibeMeet.setVoicePrint(null);
    void window.vibeMeet.setVoiceLockEnabled(false);
  }, []);

  return {
    voiceLockEnabled,
    voicePrint,
    enrollment,
    // The reject flash is driven by the capture gate in the main window; the
    // settings panel has no live feed for it, so it stays inert here.
    recentlyRejected: false,
    enrollmentToast,
    handleToggleVoiceLock,
    handleStartEnrollment,
    handleCancelEnrollment,
    handleClearEnrollment,
  };
}
