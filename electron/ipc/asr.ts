// asr.ts (IPC) - Xunfei (讯飞) IAT streaming speech-to-text IPC layer.
//
// The renderer drives a realtime stream: asr:stream-start opens a WebSocket,
// asr:stream-frame pushes VAD audio frames (fire-and-forget), asr:stream-finish
// requests the final transcript, asr:stream-cancel tears it down. An idle
// watchdog reaps streams whose frames stop arriving (mic off, renderer crash)
// so the WebSocket closes instead of uploading silence indefinitely.
//
// Credentials live in the settings store (xfyunAsr); asr:available reports
// whether they're configured. A missing key surfaces as an error - we never
// silently fall back to a local provider.

import { ipcMain } from 'electron';
import { polishAsrText } from '../asr-polish.js';
import { errorMessage } from '../format-error.js';
import { getSettings } from '../store.js';
import { XfyunIatSession, type AsrLanguage, type XfyunCredentials } from '../asr/xfyun-iat.js';
import { createWsWebSocketFactory } from '../asr/ws-transport.js';

export function registerAsrIpc(): void {
  const MAX_POLISH_CHARS = 20_000;
  const MAX_STREAM_FRAME_SAMPLES = 4_096;
  const PRE_ROLL_FRAMES = 8; // 8 × 512 samples = 256 ms at 16 kHz.
  // While a cloud stream is live the renderer pushes a VAD frame every ~32 ms.
  // If frames stop arriving for this long without stream-finish/cancel (mic
  // off, pause, renderer crash), the stream is a leak - cancel it so the
  // WebSocket closes instead of uploading silence indefinitely.
  const STREAM_IDLE_TIMEOUT_MS =
    Number.parseInt(process.env.AHASTATION_ASR_STREAM_IDLE_TIMEOUT_MS ?? '', 10) || 5_000;
  let activeStream: {
    session: XfyunIatSession;
    accepting: boolean;
    idleTimer: NodeJS.Timeout;
  } | null = null;
  let preRollFrames: Float32Array[] = [];

  const cancelActiveStream = (reason: string) => {
    const current = activeStream;
    if (!current) return;
    clearTimeout(current.idleTimer);
    current.accepting = false;
    current.session.cancel(reason);
    activeStream = null;
    preRollFrames = [];
  };

  const armIdleWatchdog = () => {
    const current = activeStream;
    if (!current) return;
    clearTimeout(current.idleTimer);
    current.idleTimer = setTimeout(() => {
      if (activeStream === current) cancelActiveStream('Xunfei stream idle timeout');
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  const validLanguage = (lang: unknown): lang is AsrLanguage =>
    lang === 'auto' || lang === 'zh' || lang === 'en';

  const rememberPreRoll = (samples: Float32Array) => {
    const copy = new Float32Array(samples.length);
    copy.set(samples);
    preRollFrames.push(copy);
    if (preRollFrames.length > PRE_ROLL_FRAMES) {
      preRollFrames = preRollFrames.slice(-PRE_ROLL_FRAMES);
    }
  };

  ipcMain.handle('asr:available', async () => {
    return {
      ok: true,
      available: readXfyunCredentials() !== null,
      provider: 'xfyun-iat' as const,
    };
  });

  ipcMain.on('asr:stream-frame', (_event, pcmBuffer: ArrayBuffer, live = false) => {
    if (!(pcmBuffer instanceof ArrayBuffer)) return;
    if (
      pcmBuffer.byteLength === 0
      || pcmBuffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
    ) return;
    const samples = new Float32Array(pcmBuffer);
    if (samples.length > MAX_STREAM_FRAME_SAMPLES) return;
    if (activeStream?.accepting && activeStream.session.canAcceptAudio && live === true) {
      activeStream.session.pushFloat32(samples);
      armIdleWatchdog();
    } else if (!activeStream || !activeStream.accepting) {
      rememberPreRoll(samples);
    }
  });

  ipcMain.handle('asr:stream-start', async (
    _event,
    options?: { lang?: AsrLanguage; includePreRoll?: boolean },
  ) => {
    try {
      // Idempotent start: renderer remounts / double-clicks must not toast
      // "already running" while a healthy stream is still accepting audio.
      if (activeStream?.accepting) {
        return { ok: true, sessionId: activeStream.session.id, reused: true };
      }
      if (activeStream) {
        try {
          activeStream.session.cancel('superseded by a new stream-start');
        } catch {
          // ignore teardown races
        }
        clearTimeout(activeStream.idleTimer);
        activeStream = null;
      }
      const credentials = readXfyunCredentials();
      if (!credentials) {
        return {
          ok: false,
          error: '讯飞 ASR 凭证未配置（设置 -> 语音 -> 讯飞 ASR）',
        };
      }
      const lang = options?.lang ?? 'auto';
      if (!validLanguage(lang)) return { ok: false, error: 'invalid ASR language' };
      const session = new XfyunIatSession(credentials, lang, createWsWebSocketFactory());
      activeStream = { session, accepting: true, idleTimer: setTimeout(() => {}, 0) };
      armIdleWatchdog();

      if (options?.includePreRoll !== false) {
        for (const frame of preRollFrames) session.pushFloat32(frame);
      }
      preRollFrames = [];

      try {
        await session.start();
        return { ok: true, sessionId: session.id };
      } catch (error) {
        session.cancel('Xunfei stream failed to start');
        if (activeStream?.session === session) {
          clearTimeout(activeStream.idleTimer);
          activeStream = null;
        }
        return { ok: false, error: errorMessage(error) };
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('asr:stream-finish', async (_event, sessionId: string) => {
    const current = activeStream;
    if (!current || current.session.id !== sessionId) {
      return { ok: false, error: 'Xunfei stream is not active' };
    }
    current.accepting = false;
    clearTimeout(current.idleTimer);
    try {
      return await current.session.finish();
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (activeStream?.session === current.session) activeStream = null;
    }
  });

  ipcMain.handle('asr:stream-cancel', async (_event, sessionId?: string) => {
    const current = activeStream;
    if (!current) {
      preRollFrames = [];
      return { ok: true };
    }
    if (sessionId && current.session.id !== sessionId) {
      return { ok: false, error: 'Xunfei stream ID does not match' };
    }
    cancelActiveStream('Xunfei stream cancelled');
    return { ok: true };
  });

  ipcMain.handle('asr:polish-text', async (_e, rawText: string) => {
    try {
      if (typeof rawText !== 'string') return { ok: false, error: 'text must be a string', text: '' };
      if (rawText.length > MAX_POLISH_CHARS) return { ok: false, error: 'text is too large', text: rawText.slice(0, MAX_POLISH_CHARS) };
      const polished = await polishAsrText(rawText);
      return { ok: true, text: polished };
    } catch (err: unknown) {
      return { ok: false, error: errorMessage(err), text: rawText };
    }
  });
}

/** Read Xunfei credentials from the settings store. Returns null when any of
 *  the three fields is missing - the caller surfaces that as an error rather
 *  than falling back to a local provider. Exported for tests. */
export function readXfyunCredentials(settings = getSettings()): XfyunCredentials | null {
  const c = settings.xfyunAsr;
  const appId = c?.appId?.trim() ?? '';
  const apiKey = c?.apiKey?.trim() ?? '';
  const apiSecret = c?.apiSecret?.trim() ?? '';
  return appId && apiKey && apiSecret ? { appId, apiKey, apiSecret } : null;
}
