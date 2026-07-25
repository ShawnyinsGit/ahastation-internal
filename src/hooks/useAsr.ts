import { useEffect, useState } from 'react';
import { useVoiceCapture } from './useVoiceCapture';
import {
  deriveMicrophoneUiState,
  type AsrMode,
  type MicrophoneCaptureStatus,
} from '../lib/microphone-ui-state';

// Xunfei (讯飞) streaming ASR is the sole speech-to-text path. asrAvailable
// reports whether credentials are configured; when they aren't the mic button
// renders disabled with a "configure Xunfei ASR" hint instead of falling back
// to a browser recognizer. This hook hides the probe + capture wiring behind a
// single interface so App doesn't manage lifecycle, and keeps `supported: true`
// while the probe is in flight so the mic button doesn't briefly render
// disabled on startup.

interface UseAsrOptions {
  enabled: boolean;
  onTranscript: (text: string) => void;
  onBargeIn?: () => void;
  lang?: 'auto' | 'zh' | 'en';
  // When true, VAD stays alive but speech segments are dropped. Used for
  // spacebar mute so the toggle is instant (no VAD destroy/recreate).
  paused?: boolean;
  suppressed?: boolean;
  voiceLockEnabled?: boolean;
  voicePrintEmbedding?: Float32Array | null;
  onVoiceLockReject?: () => void;
  tapSegment?: (samples: Float32Array) => void;
}

interface UseAsrResult {
  mode: AsrMode;
  listening: boolean;
  supported: boolean;
  lastError: string | null;
  status: MicrophoneCaptureStatus;
  retryable: boolean;
  retry: () => void;
}

export function useAsr({
  enabled,
  onTranscript,
  onBargeIn,
  lang,
  paused,
  suppressed,
  voiceLockEnabled,
  voicePrintEmbedding,
  onVoiceLockReject,
  tapSegment,
}: UseAsrOptions): UseAsrResult {
  const [asrAvailable, setAsrAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.vibeMeet
      .asrAvailable()
      .then((r) => {
        if (cancelled) return;
        const available = r.ok ? r.available : false;
        // One-shot diagnostic so we can confirm the probe result in a packaged
        // build. Without this, an unavailable state is invisible.
        console.info('[asr] probe ->', { available, raw: r });
        setAsrAvailable(available);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[asr] probe failed:', e);
        setAsrAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const mode: AsrMode =
    asrAvailable === null ? 'probing' : asrAvailable ? 'xfyun' : 'unavailable';

  // Enrollment needs raw PCM segments, which only the VAD-based path produces.
  // Whenever a `tapSegment` is requested we mount VAD even when ASR is
  // unavailable so voice-print enrollment works regardless of credential state.
  const enrollmentActive = !!tapSegment;

  const capture = useVoiceCapture({
    enabled: enabled && mode !== 'probing' && (mode === 'xfyun' || enrollmentActive),
    onTranscript,
    onBargeIn,
    lang,
    paused,
    suppressed,
    voiceLockEnabled,
    voicePrintEmbedding,
    onVoiceLockReject,
    tapSegment,
  });

  const { supported, retryable } = deriveMicrophoneUiState({
    mode,
    captureStatus: capture.status,
  });

  const lastError = mode === 'unavailable' && !enrollmentActive
    ? '讯飞 ASR 凭证未配置 - 请在 设置 → 语音 → 讯飞 ASR 中填写'
    : capture.lastError;

  const status: MicrophoneCaptureStatus =
    mode === 'probing'
      ? 'initializing'
      : mode === 'unavailable' && !enrollmentActive
        ? 'unavailable'
        : capture.status;

  return {
    mode,
    listening: capture.listening,
    supported,
    lastError,
    status,
    retryable,
    retry: capture.retry,
  };
}
