import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnrollmentToast } from '../components/VoiceLockPanel';
import { cancelSpeech } from './useSpeech';
import {
  averageEmbeddings,
  embedSpeaker,
  prewarmSpeakerModel,
  SPEAKER_MODEL_ID,
} from '../lib/speaker-embedding';
import type { VoicePrint } from '../types';

const ENROLLMENT_TARGET_SECONDS = 8;
const SAMPLE_RATE = 16000;
const ENROLLMENT_MIN_FINALIZE_SAMPLES = SAMPLE_RATE * 2;

interface EnrollmentState {
  embeddings: Float32Array[];
  capturedSamples: number;
}

interface UseVoiceLockOptions {
  muted: boolean;
  setMuted: (muted: boolean | ((prev: boolean) => boolean)) => void;
  setAiSpeaking: (speaking: boolean | ((prev: boolean) => boolean)) => void;
  speakingRef: React.MutableRefObject<boolean>;
}

export function useVoiceLock({ muted, setMuted, setAiSpeaking, speakingRef }: UseVoiceLockOptions) {
  const [voiceLockEnabled, setVoiceLockEnabled] = useState(false);
  const [voicePrint, setVoicePrint] = useState<VoicePrint | null>(null);
  const [voicePrintEmbedding, setVoicePrintEmbedding] = useState<Float32Array | null>(null);
  const [enrollment, setEnrollment] = useState<EnrollmentState | null>(null);
  const [recentlyRejected, setRecentlyRejected] = useState(false);
  const [enrollmentToast, setEnrollmentToast] = useState<EnrollmentToast>(null);

  const rejectTimerRef = useRef<number | null>(null);
  const enrollmentToastTimerRef = useRef<number | null>(null);
  const prevMutedRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.vibeMeet.getVoiceConfig().then(({ enabled, voicePrint: vp }) => {
      if (cancelled) return;
      setVoiceLockEnabled(enabled);
      if (vp) {
        setVoicePrint(vp);
        if (vp.model === SPEAKER_MODEL_ID) {
          setVoicePrintEmbedding(new Float32Array(vp.embedding));
        }
      }
      if (enabled) void prewarmSpeakerModel().catch((err) => {
        console.warn('[voiceLock] prewarmSpeakerModel failed:', err);
      });
    }).catch((err) => {
      console.error('[voiceLock] getVoiceConfig failed:', err);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => {
    if (rejectTimerRef.current != null) window.clearTimeout(rejectTimerRef.current);
    if (enrollmentToastTimerRef.current != null) window.clearTimeout(enrollmentToastTimerRef.current);
  }, []);

  // Cross-window sync: the voice config can be changed from the settings
  // window (toggle / clear / re-enroll) while this hook instance lives in the
  // main window (or vice versa). The writing side's IPC handler broadcasts
  // 'voiceconfig:changed' to every other window; refetch on receipt so the
  // capture gate never runs on a stale voiceprint or lock state.
  useEffect(() => {
    const unsubscribe = window.vibeMeet.onVoiceConfigChanged?.(() => {
      window.vibeMeet.getVoiceConfig().then(({ enabled, voicePrint: vp }) => {
        setVoiceLockEnabled(enabled);
        setVoicePrint(vp);
        setVoicePrintEmbedding(
          vp && vp.model === SPEAKER_MODEL_ID ? new Float32Array(vp.embedding) : null,
        );
      }).catch(() => {});
    });
    return unsubscribe;
  }, []);

  const showEnrollmentToast = useCallback((kind: Exclude<EnrollmentToast, null>) => {
    setEnrollmentToast(kind);
    if (enrollmentToastTimerRef.current != null) window.clearTimeout(enrollmentToastTimerRef.current);
    enrollmentToastTimerRef.current = window.setTimeout(() => {
      setEnrollmentToast(null);
      enrollmentToastTimerRef.current = null;
    }, 3500);
  }, []);

  const handleVoiceLockReject = useCallback(() => {
    setRecentlyRejected(true);
    if (rejectTimerRef.current != null) window.clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = window.setTimeout(() => {
      setRecentlyRejected(false);
      rejectTimerRef.current = null;
    }, 2500);
  }, []);

  const handleEnrollmentSegment = useCallback((samples: Float32Array) => {
    if (samples.length < 8000) return;
    void (async () => {
      try {
        const emb = await embedSpeaker(samples);
        if (!emb) return;
        setEnrollment((prev) => {
          if (!prev) return prev;
          return {
            embeddings: [...prev.embeddings, emb],
            capturedSamples: prev.capturedSamples + samples.length,
          };
        });
      } catch (e) {
        console.warn('[voice-lock] enrollment embedding failed:', e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!enrollment) return;
    const targetSamples = ENROLLMENT_TARGET_SECONDS * SAMPLE_RATE;
    if (enrollment.capturedSamples < targetSamples) return;
    const mean = averageEmbeddings(enrollment.embeddings);
    if (mean) {
      const vp: VoicePrint = {
        embedding: Array.from(mean),
        model: SPEAKER_MODEL_ID,
        secondsCaptured: enrollment.capturedSamples / SAMPLE_RATE,
        enrolledAt: Date.now(),
      };
      setVoicePrint(vp);
      setVoicePrintEmbedding(mean);
      setVoiceLockEnabled(true);
      void window.vibeMeet.setVoicePrint(vp);
      void window.vibeMeet.setVoiceLockEnabled(true);
      showEnrollmentToast('saved');
    } else {
      showEnrollmentToast('tooShort');
    }
    if (prevMutedRef.current !== null) {
      const restore = prevMutedRef.current;
      prevMutedRef.current = null;
      if (restore) setMuted(true);
    }
    setEnrollment(null);
  }, [enrollment, showEnrollmentToast, setMuted]);

  const handleToggleVoiceLock = useCallback(() => {
    setVoiceLockEnabled((prev) => {
      const next = !prev;
      void window.vibeMeet.setVoiceLockEnabled(next);
      return next;
    });
  }, []);

  const handleStartEnrollment = useCallback(() => {
    cancelSpeech();
    speakingRef.current = false;
    setAiSpeaking(false);
    if (prevMutedRef.current === null) {
      prevMutedRef.current = muted;
    }
    if (muted) setMuted(false);
    setEnrollmentToast(null);
    if (enrollmentToastTimerRef.current != null) {
      window.clearTimeout(enrollmentToastTimerRef.current);
      enrollmentToastTimerRef.current = null;
    }
    setEnrollment({ embeddings: [], capturedSamples: 0 });
  }, [muted, setMuted, setAiSpeaking]);

  const handleCancelEnrollment = useCallback(() => {
    if (enrollment && enrollment.embeddings.length > 0 && enrollment.capturedSamples >= ENROLLMENT_MIN_FINALIZE_SAMPLES) {
      const mean = averageEmbeddings(enrollment.embeddings);
      if (mean) {
        const vp: VoicePrint = {
          embedding: Array.from(mean),
          model: SPEAKER_MODEL_ID,
          secondsCaptured: enrollment.capturedSamples / SAMPLE_RATE,
          enrolledAt: Date.now(),
        };
        setVoicePrint(vp);
        setVoicePrintEmbedding(mean);
        setVoiceLockEnabled(true);
        void window.vibeMeet.setVoicePrint(vp);
        void window.vibeMeet.setVoiceLockEnabled(true);
        showEnrollmentToast('saved');
      } else {
        showEnrollmentToast('tooShort');
      }
    } else if (enrollment && enrollment.embeddings.length > 0) {
      showEnrollmentToast('tooShort');
    } else {
      showEnrollmentToast('cancelled');
    }
    setEnrollment(null);
    if (prevMutedRef.current !== null) {
      const restore = prevMutedRef.current;
      prevMutedRef.current = null;
      if (restore) setMuted(true);
    }
  }, [enrollment, showEnrollmentToast, setMuted]);

  const handleClearEnrollment = useCallback(() => {
    setVoicePrint(null);
    setVoicePrintEmbedding(null);
    setVoiceLockEnabled(false);
    void window.vibeMeet.setVoicePrint(null);
    void window.vibeMeet.setVoiceLockEnabled(false);
  }, []);

  const enrollmentProps = enrollment
    ? {
        targetSeconds: ENROLLMENT_TARGET_SECONDS,
        capturedSeconds: enrollment.capturedSamples / SAMPLE_RATE,
        segments: enrollment.embeddings.length,
      }
    : null;

  return {
    voiceLockEnabled,
    voicePrint,
    voicePrintEmbedding,
    enrollment: enrollmentProps,
    enrollmentActive: enrollment != null,
    recentlyRejected,
    enrollmentToast,
    handleToggleVoiceLock,
    handleStartEnrollment,
    handleCancelEnrollment,
    handleClearEnrollment,
    handleVoiceLockReject,
    handleEnrollmentSegment,
  };
}
