import { useCallback, useEffect, useRef, useState } from 'react';
import type { MicVAD } from '@ricky0123/vad-web';
import { cosineSimilarity, embedSpeaker } from '../lib/speaker-embedding';
import {
  serializeMicrophoneOperation,
  type MicrophoneCaptureStatus,
} from '../lib/microphone-ui-state';

// Below this many samples (~0.3s @ 16 kHz) we skip the voice-lock gate
// entirely - embeddings on very short clips are unreliable and we'd rather
// pass through brief responses ("ok", "yes") than reject them.
const MIN_SAMPLES_FOR_GATE = 4800;
const VOICE_LOCK_THRESHOLD = 0.5;
// Barge-in-during-playback gate: a speech segment that starts while TTS is
// playing must reach this many samples (~200ms @ 16 kHz) before we treat it
// as a real user interruption. Below this we assume it's AEC residue or a
// cough and drop it silently.
const MIN_SAMPLES_FOR_BARGE_IN = 3200;
// Average speech-probability needed across a suppressed segment before we
// accept it as a barge-in. The segment includes a ~240ms low-prob redemption
// tail which drags the average down significantly for short utterances.
// 0.45 accepts real speech while still rejecting pure-echo blips (which sit
// around 0.3-0.4 after AEC).
const MIN_AVG_PROB_FOR_BARGE_IN = 0.45;

async function releaseCapture(vad: MicVAD | null, stream: MediaStream | null): Promise<void> {
  try {
    await vad?.destroy();
  } catch {
    // Device release must continue even if the VAD graph is already torn down.
  } finally {
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
  }
}

interface UseVoiceCaptureOptions {
  enabled: boolean;
  onTranscript: (text: string) => void;
  onBargeIn?: () => void;
  lang?: 'auto' | 'zh' | 'en';
  // When true, VAD stays alive but all speech segments are silently dropped.
  // Used for spacebar mute - avoids the 200-500ms VAD destroy/recreate cost.
  paused?: boolean;
  // When true, drop any speech segment that starts during this window. Used to
  // ignore the mic while TTS is playing back through the speakers - otherwise
  // the VAD trips on its own output, fires barge-in (cutting Claude off), and
  // transcribes the playback as if the user said it.
  suppressed?: boolean;
  // Voice-lock gate: if enabled and an enrolled embedding is provided, each
  // captured segment is embedded and compared against the enrollment via
  // cosine similarity. Below threshold -> dropped before transcription.
  voiceLockEnabled?: boolean;
  voicePrintEmbedding?: Float32Array | null;
  onVoiceLockReject?: () => void;
  // Enrollment tap. When set, every clean speech segment is handed to the tap
  // instead of being transcribed - used by the voice-lock panel to collect
  // samples for enrollment without polluting the chat transcript. The gate is
  // also bypassed in this mode (enrollment runs before we know the voice).
  tapSegment?: (samples: Float32Array) => void;
}

interface UseVoiceCaptureResult {
  active: boolean;
  listening: boolean;
  lastError: string | null;
  permissionDenied: boolean;
  speechLevel: number;
  asrAvailable: boolean | null;
  status: MicrophoneCaptureStatus;
  retry: () => void;
}

// Use a document-relative path so it works under both the Vite dev server
// (http://localhost:5173/vad/...) and the packaged app (file:///.../dist/vad/...).
const VAD_ASSET_BASE = new URL('vad/', document.baseURI).href;

export function useVoiceCapture({
  enabled,
  onTranscript,
  onBargeIn,
  lang = 'auto',
  paused = false,
  suppressed = false,
  voiceLockEnabled = false,
  voicePrintEmbedding = null,
  onVoiceLockReject,
  tapSegment,
}: UseVoiceCaptureOptions): UseVoiceCaptureResult {
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [speechLevel, setSpeechLevel] = useState(0);
  const [asrAvailable, setAsrAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<MicrophoneCaptureStatus>('idle');
  const [retryVersion, setRetryVersion] = useState(0);

  const vadRef = useRef<MicVAD | null>(null);
  // Hold the MediaStream the VAD's getStream callback produced so we can
  // explicitly stop its tracks on teardown. MicVAD.destroy() releases its own
  // graph nodes but on some browsers does NOT stop the underlying mic tracks -
  // the OS mic indicator stays lit and a subsequent getUserMedia can hit a
  // "device busy" state until the page is reloaded. Walking getTracks() and
  // calling stop() after destroy() resolves is what actually frees the device.
  const micStreamRef = useRef<MediaStream | null>(null);
  const teardownRef = useRef<Promise<void>>(Promise.resolve());
  const initializationRef = useRef<Promise<void>>(Promise.resolve());
  const onTranscriptRef = useRef(onTranscript);
  const onBargeInRef = useRef(onBargeIn);
  const onVoiceLockRejectRef = useRef(onVoiceLockReject);
  const tapSegmentRef = useRef(tapSegment);
  const pausedRef = useRef(paused);
  // Mirrored to a ref so VAD callbacks see the current value without
  // re-instantiating the VAD on every toggle.
  const suppressedRef = useRef(suppressed);
  const voiceLockEnabledRef = useRef(voiceLockEnabled);
  const voicePrintEmbeddingRef = useRef(voicePrintEmbedding);
  // Mirror lang so swapping zh⇄en⇄auto doesn't tear down MicVAD (which
  // re-downloads the worklet + onnx model and re-prompts for mic on some
  // browsers). The stream-start call inside onSpeechEnd reads the ref.
  const langRef = useRef(lang);
  // Tracks whether the in-flight speech segment started while suppressed
  // (TTS was playing). Read at speech-end to apply the barge-in duration
  // gate: short segments are treated as echo/throat-clears and dropped,
  // long ones cancel TTS and feed the transcript.
  const segmentSuppressedRef = useRef(false);
  // Running stats for the in-flight segment: count of frames and sum of
  // speech probability. Used at speech-end with segmentSuppressedRef to
  // gate barge-in by average confidence (a single high spike isn't enough).
  const segmentFrameCountRef = useRef(0);
  const segmentProbSumRef = useRef(0);
  // Streaming ASR state. The renderer opens a Xunfei WebSocket on speech
  // start and pushes VAD frames in real time; on speech end it requests the
  // final transcript. The "live" flag gates whether frames are sent (only
  // after the stream has actually opened). The suppressed/voice-lock paths
  // defer stream start to speech-end, then replay the completed segment.
  const cloudLiveFramesRef = useRef(false);
  const cloudStreamAttemptedRef = useRef(false);
  const cloudStreamStartRef = useRef<Promise<
    | { ok: true; sessionId: string }
    | { ok: false; error: string }
  > | null>(null);

  const queueRelease = useCallback((vad: MicVAD | null, stream: MediaStream | null) => {
    const previous = teardownRef.current;
    const release = serializeMicrophoneOperation(previous, () => releaseCapture(vad, stream));
    teardownRef.current = release;
    return release;
  }, []);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);
  useEffect(() => {
    onBargeInRef.current = onBargeIn;
  }, [onBargeIn]);
  useEffect(() => {
    onVoiceLockRejectRef.current = onVoiceLockReject;
  }, [onVoiceLockReject]);
  useEffect(() => {
    tapSegmentRef.current = tapSegment;
    // When a tap is installed mid-segment (typical for enrollment: user opens
    // the panel and clicks Start while Claude's greeting echo has already
    // tripped VAD with suppressedRef=true -> segmentSuppressedRef=true), clear
    // the stale suppression flag so the in-flight segment's eventual
    // onSpeechEnd routes the audio to the tap instead of dropping it.
    if (tapSegment) {
      segmentSuppressedRef.current = false;
    }
  }, [tapSegment]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    suppressedRef.current = suppressed;
  }, [suppressed]);
  useEffect(() => {
    voiceLockEnabledRef.current = voiceLockEnabled;
  }, [voiceLockEnabled]);
  useEffect(() => {
    voicePrintEmbeddingRef.current = voicePrintEmbedding;
  }, [voicePrintEmbedding]);
  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  const retry = useCallback(() => {
    setLastError(null);
    setPermissionDenied(false);
    setRetryVersion((version) => version + 1);
  }, []);

  // Check ASR availability once on mount - reports whether Xunfei credentials
  // are configured in settings.
  useEffect(() => {
    let cancelled = false;
    window.vibeMeet
      .asrAvailable()
      .then((r) => {
        if (!cancelled) setAsrAvailable(r.ok ? r.available : false);
      })
      .catch(() => {
        if (!cancelled) setAsrAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Tear down any existing VAD + in-flight ASR stream.
      cloudLiveFramesRef.current = false;
      cloudStreamAttemptedRef.current = false;
      cloudStreamStartRef.current = null;
      void window.vibeMeet.cancelAsrStream();
      const v = vadRef.current;
      const stream = micStreamRef.current;
      vadRef.current = null;
      micStreamRef.current = null;
      void queueRelease(v, stream);
      setActive(false);
      setListening(false);
      setSpeechLevel(0);
      setStatus('idle');
      return;
    }

    let cancelled = false;
    let createdVad: MicVAD | null = null;

    const previousInitialization = initializationRef.current;
    const initialization = (async () => {
      await previousInitialization.catch(() => {});
      await teardownRef.current.catch(() => {});
      if (cancelled) return;
      try {
        setStatus('requesting-permission');
        setLastError(null);
        // Ask the OS for microphone access via the native system dialog before
        // attempting getUserMedia. On macOS this shows the native permission
        // popup when status is 'not-determined'; returns false immediately if
        // the user previously denied (they must re-enable in System Settings).
        // On non-macOS the IPC handler returns true unconditionally.
        const granted = await window.vibeMeet.requestMicPermission();
        if (cancelled) return;
        if (!granted) {
          setPermissionDenied(true);
          setLastError('Microphone permission denied - please enable in System Settings');
          setActive(false);
          setStatus('permission-denied');
          return;
        }

        setPermissionDenied(false);
        setStatus('initializing');
        const { MicVAD } = await import('@ricky0123/vad-web');
        const vad = await MicVAD.new({
          model: 'v5',
          baseAssetPath: VAD_ASSET_BASE,
          onnxWASMBasePath: VAD_ASSET_BASE,
          // Explicit AEC/NS/AGC so the speaker->mic loop is dampened. Browsers
          // default these on for `{audio: true}`, but the lib's default
          // getStream doesn't pass them through, and without AEC the VAD
          // trips on Claude's own TTS output coming back through the mic.
          getStream: async () => {
            const s = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
            // Stash the stream so the effect cleanup can stop its tracks
            // after vad.destroy() - MicVAD.destroy() doesn't always release
            // the underlying mic device on its own.
            micStreamRef.current = s;
            return s;
          },
          positiveSpeechThreshold: 0.5,
          negativeSpeechThreshold: 0.35,
          redemptionMs: 1000,
          minSpeechMs: 100,
          preSpeechPadMs: 256,
          onSpeechStart: () => {
            if (pausedRef.current) return;
            // Enrollment is a user-driven capture - never let TTS suppression
            // swallow it, otherwise the panel hangs at "waiting for mic" while
            // Claude is mid-greeting. Barge-in is also pointless here: the
            // user isn't trying to interrupt, they're recording themselves.
            const tapping = tapSegmentRef.current != null;
            // Reset per-segment stats regardless of path.
            segmentFrameCountRef.current = 0;
            segmentProbSumRef.current = 0;
            // Remember whether TTS was playing at the moment speech began.
            // The decision to barge in (or drop as echo) is deferred to
            // speech-end so we can gate by duration + average confidence;
            // firing barge-in here would let a single VAD trip from AEC
            // residue cut Claude off mid-sentence.
            segmentSuppressedRef.current = suppressedRef.current && !tapping;
            cloudLiveFramesRef.current = false;
            cloudStreamAttemptedRef.current = false;
            cloudStreamStartRef.current = null;
            // Open the streaming ASR WebSocket immediately so frames flow in
            // real time. Suppressed speech (TTS playing) and voice-lock paths
            // can't upload before their end-of-segment gate - they defer the
            // stream to onSpeechEnd and replay the completed segment there.
            if (
              !tapping
              && !segmentSuppressedRef.current
              && !voiceLockEnabledRef.current
            ) {
              cloudLiveFramesRef.current = true;
              cloudStreamAttemptedRef.current = true;
              const start = window.vibeMeet.startAsrStream(langRef.current, true);
              cloudStreamStartRef.current = start;
              void start.then((result) => {
                if (!result.ok) {
                  cloudLiveFramesRef.current = false;
                  setLastError(result.error);
                }
              }).catch((error: unknown) => {
                cloudLiveFramesRef.current = false;
                setLastError(String((error as Error)?.message ?? error));
              });
            }
            setListening(true);
            if (!tapping && !segmentSuppressedRef.current) {
              // TTS isn't playing - fire barge-in immediately so the next
              // assistant utterance (if one starts mid-segment) gets cut off
              // without waiting for speech-end.
              onBargeInRef.current?.();
            }
          },
          onSpeechEnd: async (audio: Float32Array) => {
            cloudLiveFramesRef.current = false;
            if (pausedRef.current) {
              if (cloudStreamAttemptedRef.current) void window.vibeMeet.cancelAsrStream();
              cloudStreamAttemptedRef.current = false;
              cloudStreamStartRef.current = null;
              setListening(false);
              return;
            }
            setListening(false);

            // Set once the suppressed-segment echo gate has already confirmed
            // this audio belongs to the enrolled user (a genuine barge-in).
            // Lets the lower voice-lock block skip a redundant re-embed.
            let bargeVerified = false;

            // Enrollment tap takes precedence over everything else, including
            // the suppression flag. The flag may have been set by an
            // onSpeechStart that fired during TTS playback before the user
            // installed the tap (e.g. greeting echo trips VAD, then user opens
            // the panel and clicks Start mid-segment). If we honoured the flag
            // here, the user's enrollment audio would be silently dropped and
            // the panel would hang at "等待麦克风启动…". Route to the tap and
            // clear the flag so the next segment starts clean.
            const tap = tapSegmentRef.current;
            if (tap) {
              segmentSuppressedRef.current = false;
              cloudStreamAttemptedRef.current = false;
              cloudStreamStartRef.current = null;
              try { tap(audio); } catch (e) { setLastError(String((e as Error)?.message ?? e)); }
              return;
            }

            if (segmentSuppressedRef.current) {
              // Re-check suppression at speech-end. If TTS has already stopped
              // by the time the user finished speaking (common when their
              // reply starts mid-utterance and ends after playback finishes),
              // don't apply the barge-in DROP gate - just clear the latch and
              // fall through to the normal voice-lock + transcribe path so the
              // short reply ("OK", "嗯", "好的") still reaches ASR.
              if (!suppressedRef.current) {
                segmentSuppressedRef.current = false;
                segmentFrameCountRef.current = 0;
                segmentProbSumRef.current = 0;
              } else {
                segmentSuppressedRef.current = false;
                // Segment started during TTS playback AND TTS is still playing
                // at speech-end - so this audio is either the AI's own voice
                // looping back through the mic (echo) or a real interruption.
                const frames = segmentFrameCountRef.current;
                const avgProb = frames > 0 ? segmentProbSumRef.current / frames : 0;
                segmentFrameCountRef.current = 0;
                segmentProbSumRef.current = 0;
                const lockOn = voiceLockEnabledRef.current;
                const enrolled = voicePrintEmbeddingRef.current;
                if (lockOn && enrolled) {
                  // Voice-lock is the authoritative echo filter during playback:
                  // the AI's TTS voice won't match the enrolled user, so a
                  // sub-threshold similarity means echo -> drop silently (no
                  // barge-in, no transcript). Only a match counts as a real
                  // interrupt. No short-clip bypass here - during playback an
                  // unverifiable clip is far likelier echo than a real barge-in,
                  // so anything we can't positively identify as the user drops.
                  let matched = false;
                  try {
                    const emb =
                      audio.length >= MIN_SAMPLES_FOR_GATE ? await embedSpeaker(audio) : null;
                    if (emb) {
                      const sim = cosineSimilarity(emb, enrolled);
                      matched = sim >= VOICE_LOCK_THRESHOLD;
                      console.info('[barge-in] voice-lock echo gate', {
                        sim: +sim.toFixed(3),
                        threshold: VOICE_LOCK_THRESHOLD,
                        durationSec: +(audio.length / 16000).toFixed(2),
                        decision: matched ? 'INTERRUPT' : 'DROP(echo)',
                      });
                    } else {
                      console.info('[barge-in] voice-lock echo gate: unverifiable clip during TTS -> DROP', {
                        durationSec: +(audio.length / 16000).toFixed(2),
                      });
                    }
                  } catch (e) {
                    console.error('[barge-in] echo embedding failed -> DROP to be safe:', e);
                  }
                  if (!matched) {
                    return;
                  }
                  // Confirmed the enrolled user spoke over the AI: real barge-in.
                  // Skip the redundant voice-lock re-check below.
                  bargeVerified = true;
                  onBargeInRef.current?.();
                } else {
                  // No enrolled voiceprint to compare against - fall back to the
                  // duration + average-confidence heuristic. Enough audio AND
                  // sustained high speech probability -> real interrupt;
                  // otherwise drop as echo/throat-clear/cough.
                  const longEnough = audio.length >= MIN_SAMPLES_FOR_BARGE_IN;
                  const confident = avgProb >= MIN_AVG_PROB_FOR_BARGE_IN;
                  console.info('[barge-in] suppressed-segment heuristic decision', {
                    durationSec: +(audio.length / 16000).toFixed(2),
                    minSec: +(MIN_SAMPLES_FOR_BARGE_IN / 16000).toFixed(2),
                    avgProb: +avgProb.toFixed(2),
                    minAvgProb: MIN_AVG_PROB_FOR_BARGE_IN,
                    decision: longEnough && confident ? 'INTERRUPT' : 'DROP',
                  });
                  if (!longEnough || !confident) {
                    return;
                  }
                  // Real interrupt: cut Claude off now so playback stops before
                  // the transcript even finishes. The transcript still flows
                  // through the normal voice-lock + send pipeline below.
                  onBargeInRef.current?.();
                }
              }
            } else {
              // Reset stats for the next segment.
              segmentFrameCountRef.current = 0;
              segmentProbSumRef.current = 0;
            }

            // Voice-lock gate: drop segments that don't match the enrolled
            // speaker. Skip the gate on very short clips - embeddings on
            // <0.5s of audio are too noisy to act on, and forcing the user to
            // re-say "yes"/"ok" hurts UX more than letting a stray short
            // utterance through.
            const lockOn = voiceLockEnabledRef.current;
            const enrolled = voicePrintEmbeddingRef.current;
            const durationSec = audio.length / 16000;
            if (bargeVerified) {
              // Already confirmed as the enrolled user by the suppressed-segment
              // echo gate above - skip the redundant embed + compare.
              console.info('[voice-lock] barge-in already verified, passing', {
                durationSec: +durationSec.toFixed(2),
              });
            } else if (!lockOn) {
              console.info('[voice-lock] gate=off, passing segment', {
                hasEmbedding: !!enrolled,
                durationSec: +durationSec.toFixed(2),
              });
            } else if (!enrolled) {
              console.info('[voice-lock] gate=on but no enrolled voiceprint, passing');
            } else if (audio.length < MIN_SAMPLES_FOR_GATE) {
              console.info('[voice-lock] segment too short for gate, passing', {
                durationSec: +durationSec.toFixed(2),
                minSec: MIN_SAMPLES_FOR_GATE / 16000,
              });
            } else {
              try {
                const emb = await embedSpeaker(audio);
                if (emb) {
                  const sim = cosineSimilarity(emb, enrolled);
                  const pass = sim >= VOICE_LOCK_THRESHOLD;
                  console.info('[voice-lock] check', {
                    sim: +sim.toFixed(3),
                    threshold: VOICE_LOCK_THRESHOLD,
                    durationSec: +durationSec.toFixed(2),
                    decision: pass ? 'PASS' : 'REJECT',
                    embDim: emb.length,
                    enrolledDim: enrolled.length,
                  });
                  if (!pass) {
                    onVoiceLockRejectRef.current?.();
                    return;
                  }
                } else {
                  console.warn('[voice-lock] embedSpeaker returned null (segment likely too short post-fbank), passing through');
                }
              } catch (e) {
                // Embedding failed - historically we let the segment through so
                // a flaky model load wouldn't silently swallow legitimate
                // speech. But that also masks a misconfigured gate (the user
                // thinks they're protected when they aren't), so log loudly.
                console.error('[voice-lock] embedding failed, passing through - gate is NOT enforcing:', e);
              }
            }

            // Resolve the streaming ASR session. If we opened it on
            // speech-start the frames already flowed live; otherwise (suppressed
            // or voice-lock path) open it now and replay the completed segment
            // in 512-sample frames so the transcript still covers the whole
            // utterance.
            try {
              let r:
                | { ok: true; text: string }
                | { ok: false; error: string };
              let started:
                | { ok: true; sessionId: string }
                | { ok: false; error: string };
              if (cloudStreamAttemptedRef.current && cloudStreamStartRef.current) {
                started = await cloudStreamStartRef.current;
              } else {
                started = await window.vibeMeet.startAsrStream(langRef.current, false);
                if (started.ok) {
                  const VAD_FRAME_SAMPLES = 512;
                  for (let offset = 0; offset < audio.length; offset += VAD_FRAME_SAMPLES) {
                    const end = Math.min(audio.length, offset + VAD_FRAME_SAMPLES);
                    const frame = new Float32Array(end - offset);
                    frame.set(audio.subarray(offset, end));
                    window.vibeMeet.sendAsrStreamFrame(frame.buffer, true);
                  }
                }
              }
              cloudStreamAttemptedRef.current = false;
              cloudStreamStartRef.current = null;
              if (!started.ok) {
                r = started;
              } else {
                r = await window.vibeMeet.finishAsrStream(started.sessionId);
              }
              if (r.ok && r.text.trim()) {
                onTranscriptRef.current(r.text.trim());
              } else if (!r.ok) {
                setLastError(r.error);
              }
            } catch (e) {
              setLastError(String((e as Error)?.message ?? e));
            }
          },
          onVADMisfire: () => {
            cloudLiveFramesRef.current = false;
            if (cloudStreamAttemptedRef.current) void window.vibeMeet.cancelAsrStream();
            cloudStreamAttemptedRef.current = false;
            cloudStreamStartRef.current = null;
            segmentSuppressedRef.current = false;
            segmentFrameCountRef.current = 0;
            segmentProbSumRef.current = 0;
            setListening(false);
          },
          onFrameProcessed: (probs, frame) => {
            // Push the VAD frame to the streaming ASR WebSocket while a live
            // stream is accepting audio. The copy is needed because the VAD
            // reuses the frame buffer and ipcRenderer.send serializes
            // asynchronously.
            if (
              !pausedRef.current
              && tapSegmentRef.current == null
              && cloudLiveFramesRef.current
            ) {
              const copy = new Float32Array(frame.length);
              copy.set(frame);
              window.vibeMeet.sendAsrStreamFrame(copy.buffer, true);
            }
            // Cheap UI signal: smoothed speech probability for the mic meter.
            setSpeechLevel((prev) => prev * 0.6 + probs.isSpeech * 0.4);
            // Accumulate per-segment stats used by the barge-in gate at
            // speech-end. The library calls this for every frame, including
            // silence between segments; the running totals are reset in
            // onSpeechStart so only the in-flight segment's frames count.
            segmentFrameCountRef.current += 1;
            segmentProbSumRef.current += probs.isSpeech;
          },
        });
        if (cancelled) {
          const stream = micStreamRef.current;
          micStreamRef.current = null;
          await queueRelease(vad, stream);
          return;
        }
        createdVad = vad;
        vadRef.current = vad;
        await vad.start();
        if (cancelled) return;
        setActive(true);
        setLastError(null);
        setStatus('ready');
      } catch (e) {
        // Init failed after getStream may have already resolved (e.g. MicVAD
        // worklet load threw). Release the mic track we grabbed so the OS
        // indicator turns off and the device isn't held hostage by a failed
        // session.
        const stream = micStreamRef.current;
        micStreamRef.current = null;
        await queueRelease(createdVad, stream);
        const msg = String((e as Error)?.message ?? e);
        // B18: detect permission denial so the UI can show a targeted guide
        // instead of a generic error string.
        const isPerm = e instanceof DOMException && (
          e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
        );
        if (cancelled) return;
        setPermissionDenied(isPerm);
        setLastError(isPerm ? 'Microphone permission denied - please enable in System Settings' : `Mic init failed: ${msg}`);
        setActive(false);
        setStatus(isPerm ? 'permission-denied' : 'failed');
      }
    })();
    initializationRef.current = initialization;

    return () => {
      cancelled = true;
      cloudLiveFramesRef.current = false;
      cloudStreamAttemptedRef.current = false;
      cloudStreamStartRef.current = null;
      void window.vibeMeet.cancelAsrStream();
      const stream = micStreamRef.current;
      micStreamRef.current = null;
      void queueRelease(createdVad, stream);
      if (vadRef.current === createdVad) vadRef.current = null;
      setActive(false);
      setListening(false);
    };
  }, [enabled, retryVersion, queueRelease]);

  return { active, listening, lastError, permissionDenied, speechLevel, asrAvailable, status, retry };
}
