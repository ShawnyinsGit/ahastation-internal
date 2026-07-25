// ws-transport.ts - Node/Electron WebSocket transport for Xunfei IAT.
//
// Node's built-in WebSocket (undici) can fail silently on some Windows/proxy
// setups. The `ws` package handles the upgrade handshake reliably and surfaces
// HTTP auth errors during connect.

import WebSocket from 'ws';
import type { WebSocketFactory, WebSocketLike } from './xfyun-iat.js';

type WebSocketEvent = { data?: unknown; message?: string; error?: unknown };
type WebSocketListener = (event: WebSocketEvent) => void;

export function websocketErrorMessage(event: WebSocketEvent): string {
  if (typeof event.message === 'string' && event.message.trim()) return event.message;
  const nested = event.error;
  if (nested instanceof Error && nested.message.trim()) return nested.message;
  if (typeof nested === 'string' && nested.trim()) return nested;
  return 'Xunfei WebSocket connection failed';
}

function wrapWsSocket(socket: WebSocket): WebSocketLike {
  const listeners = new Map<'open' | 'message' | 'error' | 'close', Set<WebSocketListener>>();

  const emit = (type: 'open' | 'message' | 'error' | 'close', event: WebSocketEvent = {}) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };

  socket.on('open', () => emit('open'));
  socket.on('message', (data) => emit('message', { data }));
  socket.on('error', (error) => {
    emit('error', {
      message: error instanceof Error ? error.message : String(error),
      error,
    });
  });
  socket.on('close', () => emit('close'));
  socket.on('unexpected-response', (_request, response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let message = `HTTP ${response.statusCode ?? 0} ${response.statusMessage ?? 'Error'}`;
      try {
        const parsed = JSON.parse(body) as { message?: unknown };
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
          message += `: ${parsed.message}`;
        }
      } catch {
        if (body.trim()) message += `: ${body.trim()}`;
      }
      emit('error', { message });
    });
  });

  return {
    get readyState() {
      return socket.readyState;
    },
    addEventListener(type, listener) {
      const bucket = listeners.get(type) ?? new Set<WebSocketListener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  };
}

export const createWsWebSocketFactory = (): WebSocketFactory =>
  (url) => wrapWsSocket(new WebSocket(url));
