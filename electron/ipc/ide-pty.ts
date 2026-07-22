// ide-pty.ts — PTY terminal IPC + main-process WebSocket proxy (Phase 4).
//
// Protocol (all spike §6 verified): REST management plane (POST /pty,
// PUT /pty/{id} {size}, DELETE /pty/{id}) + WS data plane
// (/pty/{id}/connect). Browsers can't set WebSocket headers, so main owns
// the WS and injects Basic auth — verified on Electron 42's embedded Node:
// `new WebSocket(url, { headers })` delivers the Authorization header.
// Resize goes through REST PUT — WS control frames would be interpreted as
// terminal keyboard input (spike §6), never sent.
//
// Security (§2.2 rule 8): every channel is gated on the sender being a
// registered editor window; the server is acquired through the shared
// registry (refcount +1 per live PTY); input frames are size/rate limited;
// creation is audit-logged; window close / WS close (incl. server
// shutdown) tears the session down.

import { z } from 'zod';
import {
  resolveEditorContextByWebContentsId,
  forwardToEditorWindow,
  onEditorWindowClosed,
} from '../ide/ide-window-manager.js';
import {
  defaultServerSpawn,
  getOpencodeServerRegistry,
} from '../ide/opencode/opencode-server-registry.js';
import { basicAuthHeader } from '../backends/opencode-server-process.js';
import { OPENCODE_SERVER_CONFIG } from '../backends/opencode-adapter.js';
import type { IpcContext } from './context.js';
import { editorWindowSenderPolicy, emptyPayloadSchema, handleSecure } from './validators.js';

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export const PTY_INPUT_MAX_BYTES = 8192;
export const PTY_INPUT_MAX_PER_SECOND = 60;

/** Per-window input limiter: drop frames over 8KB or over 60/sec (rule 8). */
export class PtyInputLimiter {
  private second = -1;
  private count = 0;
  dropped = 0;

  allow(bytes: number, now: number = Date.now()): boolean {
    if (bytes > PTY_INPUT_MAX_BYTES) {
      this.dropped += 1;
      return false;
    }
    const sec = Math.floor(now / 1000);
    if (sec !== this.second) {
      this.second = sec;
      this.count = 0;
    }
    if (this.count >= PTY_INPUT_MAX_PER_SECOND) {
      this.dropped += 1;
      return false;
    }
    this.count += 1;
    return true;
  }
}

/** Resize body for PUT /pty/{id} — clamped to sane terminal dimensions. */
export function buildPtyResizeBody(rows: number, cols: number): { size: { rows: number; cols: number } } {
  const clamp = (n: number) => Math.min(500, Math.max(1, Math.floor(n) || 1));
  return { size: { rows: clamp(rows), cols: clamp(cols) } };
}

export type PtyDownlink =
  | { kind: 'pty-data'; data: string; encoding: 'utf8' | 'base64' }
  | { kind: 'pty-exit'; exitCode: number | null }
  | { kind: 'pty-error'; error: string };

/** Downlink frame encoder: text frames pass through as utf8; binary frames
 *  (the server mixes them, spike §6) are base64'd for the IPC hop. */
export function encodePtyData(data: string | Buffer): PtyDownlink {
  if (typeof data === 'string') {
    return { kind: 'pty-data', data, encoding: 'utf8' };
  }
  return { kind: 'pty-data', data: data.toString('base64'), encoding: 'base64' };
}

/** One-PTY-per-window book (rule 8: per-window cap of 1). */
export class PtySessionBook {
  private readonly ptyIdByWindow = new Map<number, string>();

  get(webContentsId: number): string | null {
    return this.ptyIdByWindow.get(webContentsId) ?? null;
  }

  /** Returns false when the window already owns a PTY. */
  setIfAbsent(webContentsId: number, ptyId: string): boolean {
    if (this.ptyIdByWindow.has(webContentsId)) return false;
    this.ptyIdByWindow.set(webContentsId, ptyId);
    return true;
  }

  remove(webContentsId: number): boolean {
    return this.ptyIdByWindow.delete(webContentsId);
  }

  get size(): number {
    return this.ptyIdByWindow.size;
  }
}

// ── Live session state (main-side, keyed by hostId) ───────────────────────
// One PTY per host — equivalent to one-per-window for independent windows
// (hostId-keyed) and correct for the overlay, where every host shares the
// main window's webContents (Phase 6a).

interface LivePty {
  ptyId: string;
  hostId: string;
  serverKey: string;
  url: string;
  password: string;
  ws: WebSocket;
  limiter: PtyInputLimiter;
  closed: boolean;
}

const livePtys = new Map<string, LivePty>();

async function restJson(
  method: string,
  url: string,
  password: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: basicAuthHeader(password),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function teardownPty(hostId: string, notify: boolean): void {
  const live = livePtys.get(hostId);
  if (!live || live.closed) return;
  live.closed = true;
  livePtys.delete(hostId);
  try {
    live.ws.close();
  } catch { /* already closed */ }
  // Release the registry refcount held by this PTY.
  void getOpencodeServerRegistry().release(live.serverKey);
  // Best-effort REST delete so the server reaps the shell process.
  void restJson('DELETE', `${live.url}/pty/${live.ptyId}`, live.password).catch(() => undefined);
  if (notify) {
    forwardToEditorWindow(live.hostId, { kind: 'pty-exit', exitCode: null } satisfies PtyDownlink);
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────

export const idePtyInputSchema = z
  .object({ data: z.string().min(1).max(PTY_INPUT_MAX_BYTES) })
  .strict();

export const idePtyResizeSchema = z
  .object({
    rows: z.number().int().min(1).max(500),
    cols: z.number().int().min(1).max(500),
  })
  .strict();

export function registerIdePtyIpc(ctx: IpcContext): void {
  const editorOnly = editorWindowSenderPolicy();
  const editorOnlyError = 'Sender is not a registered editor window';

  // Window closed → tear down its PTY (renderer is gone; main owns cleanup).
  onEditorWindowClosed((hostId) => {
    teardownPty(hostId, false);
  });

  handleSecure('ide-pty:create', {
    schema: emptyPayloadSchema,
    authorize: editorOnly,
    authorizeError: editorOnlyError,
    handler: async (_payload, senderId) => {
      const editorContext = resolveEditorContextByWebContentsId(senderId);
      if (!editorContext) return { ok: false, error: editorOnlyError };
      const hostId = editorContext.hostId;

      const existing = livePtys.get(hostId);
      if (existing && !existing.closed) {
        return { ok: true, ptyId: existing.ptyId, existing: true };
      }

      const slot = ctx.registry.get(editorContext.sessionId);
      const meetingId = slot?.orchestrator.getMeetingId();
      if (!meetingId) {
        return { ok: false, error: 'Meeting slot for this window is gone' };
      }

      // Shared server for this meeting+cwd; the PTY holds one refcount.
      const acquired = await getOpencodeServerRegistry().acquire({
        meetingId,
        cwd: editorContext.cwd,
        spawn: () => defaultServerSpawn({ cwd: editorContext.cwd, config: OPENCODE_SERVER_CONFIG }),
      });

      // §2.2 rule 8: create = explicit user action (audit-logged, no native
      // dialog). The shell command runs server-side in the pinned cwd.
      const shell = process.env.SHELL || '/bin/bash';
      console.log(`[ide-pty] AUDIT create: host=${hostId} cwd=${editorContext.cwd} shell=${shell}`);
      const created = await restJson('POST', `${acquired.handle.url}/pty`, acquired.handle.password, {
        command: shell,
        args: [],
        title: `AhaMeet ${hostId}`,
      });
      if (!created.ok || !created.data || typeof (created.data as { id?: unknown }).id !== 'string') {
        await getOpencodeServerRegistry().release(acquired.key);
        return { ok: false, error: `PTY create failed (HTTP ${created.status})` };
      }
      const ptyId = (created.data as { id: string }).id;

      // WS data plane with Basic auth header (browser WebSocket can't set
      // headers — that is exactly why main owns this connection).
      const wsUrl = `${acquired.handle.url.replace(/^http/, 'ws')}/pty/${ptyId}/connect`;
      const ws = new WebSocket(wsUrl, {
        headers: { authorization: basicAuthHeader(acquired.handle.password) },
      } as Record<string, unknown>);
      ws.binaryType = 'arraybuffer';

      const live: LivePty = {
        ptyId,
        hostId,
        serverKey: acquired.key,
        url: acquired.handle.url,
        password: acquired.handle.password,
        ws,
        limiter: new PtyInputLimiter(),
        closed: false,
      };
      livePtys.set(hostId, live);

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string'
          ? ev.data
          : Buffer.from(ev.data as ArrayBuffer);
        forwardToEditorWindow(live.hostId, encodePtyData(data));
      };
      ws.onclose = () => {
        // Server shutdown / pty exit / network drop — main cleans up.
        teardownPty(hostId, true);
      };
      ws.onerror = () => {
        forwardToEditorWindow(live.hostId, { kind: 'pty-error', error: 'PTY WebSocket error' } satisfies PtyDownlink);
      };

      return { ok: true, ptyId, existing: false };
    },
  });

  handleSecure('ide-pty:input', {
    schema: idePtyInputSchema,
    authorize: editorOnly,
    authorizeError: editorOnlyError,
    handler: (payload, senderId) => {
      const editorContext = resolveEditorContextByWebContentsId(senderId);
      if (!editorContext) return { ok: false, error: editorOnlyError };
      const live = livePtys.get(editorContext.hostId);
      if (!live || live.closed) return { ok: false, error: 'No live PTY for this window' };
      if (!live.limiter.allow(Buffer.byteLength(payload.data, 'utf8'))) {
        return { ok: false, error: 'PTY input rate/size limit exceeded', dropped: true };
      }
      live.ws.send(payload.data); // text frame (server accepts both, spike §6)
      return { ok: true };
    },
  });

  handleSecure('ide-pty:resize', {
    schema: idePtyResizeSchema,
    authorize: editorOnly,
    authorizeError: editorOnlyError,
    handler: async (payload, senderId) => {
      const editorContext = resolveEditorContextByWebContentsId(senderId);
      if (!editorContext) return { ok: false, error: editorOnlyError };
      const live = livePtys.get(editorContext.hostId);
      if (!live || live.closed) return { ok: false, error: 'No live PTY for this window' };
      // REST PUT — never a WS control frame (spike §6: those become input).
      const res = await restJson(
        'PUT',
        `${live.url}/pty/${live.ptyId}`,
        live.password,
        buildPtyResizeBody(payload.rows, payload.cols),
      );
      return res.ok ? { ok: true } : { ok: false, error: `PTY resize failed (HTTP ${res.status})` };
    },
  });

  handleSecure('ide-pty:close', {
    schema: emptyPayloadSchema,
    authorize: editorOnly,
    authorizeError: editorOnlyError,
    handler: (_payload, senderId) => {
      const editorContext = resolveEditorContextByWebContentsId(senderId);
      if (!editorContext) return { ok: false, error: editorOnlyError };
      teardownPty(editorContext.hostId, false);
      return { ok: true };
    },
  });
}
