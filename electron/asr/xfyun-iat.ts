// xfyun-iat.ts - iFlytek (讯飞) IAT streaming speech-to-text client.
//
// Replaces the previous on-device whisper.cpp + OpenAI-compatible cloud ASR
// paths. Streaming WebSocket: the renderer pushes VAD frames in real time via
// the IPC layer (ipc/asr.ts), this module frames them at 1280 bytes / 40 ms,
// authenticates with an HMAC-signed URL, and assembles the dynamic-correction
// result segments into final text.
//
// Pure module: no electron imports, no process.env reads - credentials are
// passed in by the caller (the IPC layer reads them from the settings store).
// WebSocket construction is injectable so node:test can drive it with a fake.

import { createHmac, randomUUID } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { float32ToPcm16 } from './pcm16.js';

export type AsrLanguage = 'auto' | 'zh' | 'en';

export interface XfyunCredentials {
  appId: string;
  apiKey: string;
  apiSecret: string;
}

export interface XfyunResult {
  ok: true;
  text: string;
}

type WebSocketEvent = { data?: unknown; message?: string; error?: unknown };
type WebSocketListener = (event: WebSocketEvent) => void;

export interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: WebSocketListener): void;
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: WebSocketListener): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const HOST = 'iat-api.xfyun.cn';
const PATH = '/v2/iat';
const ENDPOINT = `wss://${HOST}${PATH}`;
const FRAME_BYTES = 1_280;
const FRAME_INTERVAL_MS = 40;
const MAX_AUDIO_BYTES = 55 * 16_000 * Int16Array.BYTES_PER_ELEMENT;
const CONNECT_TIMEOUT_MS = 10_000;
const FINAL_TIMEOUT_MS = 15_000;
const WS_OPEN = 1;

export function buildXfyunAuthUrl(
  credentials: Pick<XfyunCredentials, 'apiKey' | 'apiSecret'>,
  now = new Date(),
): string {
  const date = now.toUTCString();
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`;
  const signature = createHmac('sha256', credentials.apiSecret)
    .update(signatureOrigin)
    .digest('base64');
  const authorizationOrigin = [
    `api_key="${credentials.apiKey}"`,
    'algorithm="hmac-sha256"',
    'headers="host date request-line"',
    `signature="${signature}"`,
  ].join(', ');
  const authorization = Buffer.from(authorizationOrigin, 'utf8').toString('base64');
  const query = new URLSearchParams({ authorization, date, host: HOST });
  return `${ENDPOINT}?${query.toString()}`;
}

function languageBusiness(lang: AsrLanguage): Record<string, string | number> {
  if (lang === 'en') {
    return {
      language: 'en_us',
      domain: 'iat',
      dwa: 'wpgs',
      ptt: 1,
      eos: 2_000,
    };
  }
  return {
    language: 'zh_cn',
    domain: 'iat',
    accent: 'mandarin',
    dwa: 'wpgs',
    ptt: 1,
    eos: 2_000,
  };
}

function messageText(data: unknown): Promise<string> {
  if (typeof data === 'string') return Promise.resolve(data);
  if (Buffer.isBuffer(data)) return Promise.resolve(data.toString('utf8'));
  if (data instanceof ArrayBuffer) return Promise.resolve(Buffer.from(data).toString('utf8'));
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
  }
  if (data && typeof (data as { text?: unknown }).text === 'function') {
    return (data as { text: () => Promise<string> }).text();
  }
  return Promise.resolve(String(data ?? ''));
}

export class XfyunResultAssembler {
  private readonly segments = new Map<number, string>();
  private fallbackSequence = 0;

  accept(result: unknown): void {
    if (!result || typeof result !== 'object') return;
    const value = result as {
      sn?: unknown;
      pgs?: unknown;
      rg?: unknown;
      ws?: unknown;
    };
    const sn = typeof value.sn === 'number' ? value.sn : this.fallbackSequence++;
    const words: string[] = [];
    if (Array.isArray(value.ws)) {
      for (const item of value.ws) {
        if (!item || typeof item !== 'object') continue;
        const candidates = (item as { cw?: unknown }).cw;
        if (!Array.isArray(candidates) || candidates.length === 0) continue;
        const first = candidates[0];
        if (first && typeof first === 'object') {
          const word = (first as { w?: unknown }).w;
          if (typeof word === 'string') words.push(word);
        }
      }
    }

    if (value.pgs === 'rpl' && Array.isArray(value.rg) && value.rg.length >= 2) {
      const start = Number(value.rg[0]);
      const end = Number(value.rg[1]);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        for (let index = start; index <= end; index += 1) this.segments.delete(index);
      }
    }
    this.segments.set(sn, words.join(''));
  }

  text(): string {
    return [...this.segments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join('')
      .trim();
  }
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const Constructor = (globalThis as unknown as {
    WebSocket?: new (target: string) => WebSocketLike;
  }).WebSocket;
  if (!Constructor) throw new Error('WebSocket runtime is unavailable');
  return new Constructor(url);
}

export class XfyunIatSession {
  readonly id = randomUUID();
  private socket: WebSocketLike | null = null;
  private pendingAudio: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private sentAudioBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private firstFrame = true;
  private accepting = true;
  private finishRequested = false;
  private finalFrameSent = false;
  private settled = false;
  private fatalError: Error | null = null;
  private readonly assembler = new XfyunResultAssembler();
  private readonly finalPromise: Promise<XfyunResult>;
  private resolveFinal!: (result: XfyunResult) => void;
  private rejectFinal!: (error: Error) => void;

  constructor(
    private readonly credentials: XfyunCredentials,
    private readonly lang: AsrLanguage,
    private readonly webSocketFactory: WebSocketFactory = defaultWebSocketFactory,
  ) {
    this.finalPromise = new Promise<XfyunResult>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    // A connection can fail before the renderer reaches stream-finish.
    // Attach a sink immediately so Node does not report an unhandled rejection.
    void this.finalPromise.catch(() => {});
  }

  get canAcceptAudio(): boolean {
    return this.accepting && !this.fatalError;
  }

  async start(): Promise<void> {
    if (this.socket) throw new Error('Xunfei stream already started');
    const socket = this.webSocketFactory(buildXfyunAuthUrl(this.credentials));
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timeout = setTimeout(() => finish(new Error('Xunfei WebSocket connection timed out')), CONNECT_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
      };
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = (event: WebSocketEvent) => {
        finish(new Error(event.message || 'Xunfei WebSocket connection failed'));
      };
      const onClose = () => finish(new Error('Xunfei WebSocket closed during connection'));
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
    });

    socket.addEventListener('message', this.onMessage);
    socket.addEventListener('error', this.onRuntimeError);
    socket.addEventListener('close', this.onRuntimeClose);
    this.timer = setInterval(() => this.sendNextFrame(), FRAME_INTERVAL_MS);
  }

  pushFloat32(samples: Float32Array): void {
    if (!this.canAcceptAudio || samples.length === 0) return;
    const pcm = float32ToPcm16(samples);
    if (this.sentAudioBytes + this.pendingAudio.length + pcm.length > MAX_AUDIO_BYTES) {
      this.fail(new Error('Xunfei stream exceeds the 55 second prototype limit'));
      return;
    }
    this.pendingAudio = this.pendingAudio.length
      ? Buffer.concat([this.pendingAudio, pcm])
      : pcm;
  }

  async finish(): Promise<XfyunResult> {
    if (this.fatalError) throw this.fatalError;
    this.accepting = false;
    this.finishRequested = true;
    let timeoutId: NodeJS.Timeout | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('Xunfei final result timed out')),
        FINAL_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([this.finalPromise, timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.stopTimer();
      this.closeSocket();
    }
  }

  cancel(reason = 'Xunfei stream cancelled'): void {
    this.accepting = false;
    this.fail(new Error(reason));
  }

  private sendNextFrame(): void {
    if (this.fatalError || !this.socket || this.socket.readyState !== WS_OPEN || this.finalFrameSent) return;
    if (this.pendingAudio.length >= FRAME_BYTES) {
      const frame = this.pendingAudio.subarray(0, FRAME_BYTES);
      this.pendingAudio = this.pendingAudio.subarray(FRAME_BYTES);
      this.sendAudio(frame);
      return;
    }
    if (!this.finishRequested) return;
    if (this.pendingAudio.length > 0) {
      const remainder = this.pendingAudio;
      this.pendingAudio = Buffer.alloc(0);
      this.sendAudio(remainder);
      return;
    }
    if (this.firstFrame) this.sendAudio(Buffer.alloc(0));
    this.sendFinalFrame();
  }

  private sendAudio(audio: Buffer): void {
    if (!this.socket) return;
    const status = this.firstFrame ? 0 : 1;
    const payload: Record<string, unknown> = {
      data: {
        status,
        format: 'audio/L16;rate=16000',
        encoding: 'raw',
        audio: audio.toString('base64'),
      },
    };
    if (this.firstFrame) {
      payload.common = { app_id: this.credentials.appId };
      payload.business = languageBusiness(this.lang);
      this.firstFrame = false;
    }
    this.socket.send(JSON.stringify(payload));
    this.sentAudioBytes += audio.length;
  }

  private sendFinalFrame(): void {
    if (!this.socket || this.finalFrameSent) return;
    this.finalFrameSent = true;
    this.socket.send(JSON.stringify({
      data: {
        status: 2,
        format: 'audio/L16;rate=16000',
        encoding: 'raw',
        audio: '',
      },
    }));
  }

  private readonly onMessage = (event: WebSocketEvent) => {
    void messageText(event.data).then((raw) => {
      let response: {
        code?: unknown;
        message?: unknown;
        data?: { status?: unknown; result?: unknown };
      };
      try {
        response = JSON.parse(raw) as typeof response;
      } catch {
        this.fail(new Error('Xunfei returned invalid JSON'));
        return;
      }
      if (response.code !== 0) {
        this.fail(new Error(`Xunfei error ${String(response.code)}: ${String(response.message ?? 'unknown error')}`));
        return;
      }
      if (response.data?.result) this.assembler.accept(response.data.result);
      if (response.data?.status === 2 && !this.settled) {
        this.settled = true;
        this.accepting = false;
        this.resolveFinal({ ok: true, text: this.assembler.text() });
      }
    }).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  };

  private readonly onRuntimeError = (event: WebSocketEvent) => {
    this.fail(new Error(event.message || 'Xunfei WebSocket failed'));
  };

  private readonly onRuntimeClose = () => {
    if (!this.settled && !this.fatalError) this.fail(new Error('Xunfei WebSocket closed before final result'));
  };

  private fail(error: Error): void {
    if (this.settled || this.fatalError) return;
    this.fatalError = error;
    this.accepting = false;
    this.settled = true;
    this.stopTimer();
    this.rejectFinal(error);
    this.closeSocket();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    socket.removeEventListener('message', this.onMessage);
    socket.removeEventListener('error', this.onRuntimeError);
    socket.removeEventListener('close', this.onRuntimeClose);
    try {
      socket.close(1000, 'done');
    } catch {
      // The remote endpoint may already have closed the socket.
    }
    this.socket = null;
  }
}
