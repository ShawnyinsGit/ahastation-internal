// ipc/shell-pty.ts - renderer bridge for the main-window shell terminal.
//
// Unlike worker-pty (adapter-owned lifecycle), the shell PTY is owned by the
// renderer: the user opens the bottom drawer, the renderer creates the shell;
// the user closes it, the renderer kills it. The host (pty-host.ts) and its
// ring buffer / base64 transport / PtyInputLimiter are shared with worker-pty
// - this is the second IPC namespace on the same host, not a third PTY stack.
//
// create spawns the user's default shell (resolveDefaultShell) in the meeting
// cwd, attaches the caller (live 'shell-pty:data' events, base64), and returns
// the ptyId. input/resize/kill are renderer-driven. create is audit-logged
// (same rule-8 posture as ide-pty). Sender: main window only.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPtyHost, resolveDefaultShell } from '../pty-host.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import type { IpcContext } from './context.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';
import { PtyInputLimiter, PTY_INPUT_MAX_BYTES } from './ide-pty.js';

const PTY_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export const shellPtyCreateSchema = z
  .object({
    cwd: z.string().min(1).max(1024).optional(),
    cols: z.number().int().min(1).max(500).optional(),
    rows: z.number().int().min(1).max(500).optional(),
  })
  .strict();

export const shellPtyIdSchema = z
  .object({ ptyId: z.string().regex(PTY_ID_RE) })
  .strict();

export const shellPtyInputSchema = z
  .object({
    ptyId: z.string().regex(PTY_ID_RE),
    data: z.string().min(1).max(PTY_INPUT_MAX_BYTES),
  })
  .strict();

export const shellPtyResizeSchema = z
  .object({
    ptyId: z.string().regex(PTY_ID_RE),
    rows: z.number().int().min(1).max(500),
    cols: z.number().int().min(1).max(500),
  })
  .strict();

export interface ShellPtyDataEvent {
  ptyId: string;
  data: string; // base64
}

export interface ShellPtyExitEvent {
  ptyId: string;
  exitCode: number | null;
}

interface Attachment {
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
  limiter: PtyInputLimiter;
}

export function registerShellPtyIpc(ctx: IpcContext): void {
  const mainOnly = mainWindowSenderPolicy(
    () => ctx.liveWindow()?.webContents.id ?? null,
  );
  const mainOnlyError = 'Sender is not the main window';
  const attachments = new Map<string, Attachment>();

  const detach = (ptyId: string): void => {
    const att = attachments.get(ptyId);
    if (!att) return;
    att.unsubscribeData();
    att.unsubscribeExit();
    attachments.delete(ptyId);
  };

  handleSecure('shell-pty:create', {
    schema: shellPtyCreateSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      const host = getPtyHost();
      const ptyId = `shell-${randomUUID()}`;
      const cwd = payload.cwd ?? ctx.getCurrentCwd() ?? process.cwd();
      const file = resolveDefaultShell();
      console.log(`[shell-pty] AUDIT create: ptyId=${ptyId} cwd=${cwd} shell=${file}`);
      host.spawn(ptyId, {
        file,
        args: [],
        cwd,
        env: mergedSubprocessEnv(),
        cols: payload.cols ?? 100,
        rows: payload.rows ?? 30,
      });
      const send = (channel: string, data: unknown) => {
        ctx.liveWindow()?.webContents.send(channel, data);
      };
      const unsubscribeData = host.onData(ptyId, (data) => {
        send('shell-pty:data', {
          ptyId,
          data: Buffer.from(data, 'utf8').toString('base64'),
        } satisfies ShellPtyDataEvent);
      });
      const unsubscribeExit = host.onExit(ptyId, (exitCode) => {
        detach(ptyId);
        send('shell-pty:exit', { ptyId, exitCode } satisfies ShellPtyExitEvent);
      });
      attachments.set(ptyId, {
        unsubscribeData,
        unsubscribeExit,
        limiter: new PtyInputLimiter(),
      });
      const replay = host.replayBuffer(ptyId);
      return { ok: true, ptyId, replay: replay ? replay.toString('base64') : '' };
    },
  });

  handleSecure('shell-pty:input', {
    schema: shellPtyInputSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      const att = attachments.get(payload.ptyId);
      if (!att) return { ok: false, error: 'No live shell PTY for this id' };
      if (!att.limiter.allow(Buffer.byteLength(payload.data, 'utf8'))) {
        return { ok: false, error: 'PTY input rate/size limit exceeded', dropped: true };
      }
      const ok = getPtyHost().write(payload.ptyId, payload.data);
      return ok ? { ok: true } : { ok: false, error: 'No live shell PTY for this id' };
    },
  });

  handleSecure('shell-pty:resize', {
    schema: shellPtyResizeSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      const ok = getPtyHost().resize(payload.ptyId, payload.rows, payload.cols);
      return ok ? { ok: true } : { ok: false, error: 'No live shell PTY for this id' };
    },
  });

  handleSecure('shell-pty:kill', {
    schema: shellPtyIdSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      detach(payload.ptyId);
      getPtyHost().kill(payload.ptyId);
      return { ok: true };
    },
  });
}
