// ipc/worker-pty.ts — renderer bridge for terminal-mode worker PTYs.
//
// The pty itself is owned by PtyHost (spawned/killed by the
// claude-terminal-adapter). This module only lets the MAIN WINDOW attach to
// an existing pty for display + keyboard takeover:
//   attach  → replay the ring buffer, then mirror live output as
//             'worker-pty:data' events (base64 payload, per spike: pty data
//             may contain arbitrary bytes / split escape sequences).
//   input   → user keystrokes, size/rate limited like ide-pty (rule 8).
//   resize  → clamped rows/cols forwarded to the pty.
//   detach  → stop mirroring; the pty keeps running (worker owns lifecycle).
//
// Sender attribution: main window only — stage terminals render there.

import { z } from 'zod';
import { getPtyHost } from '../pty-host.js';
import type { IpcContext } from './context.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';
import { PtyInputLimiter, PTY_INPUT_MAX_BYTES } from './ide-pty.js';

const WORKER_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export const workerPtyAttachSchema = z
  .object({ workerId: z.string().regex(WORKER_ID_RE) })
  .strict();

export const workerPtyInputSchema = z
  .object({
    workerId: z.string().regex(WORKER_ID_RE),
    data: z.string().min(1).max(PTY_INPUT_MAX_BYTES),
  })
  .strict();

export const workerPtyResizeSchema = z
  .object({
    workerId: z.string().regex(WORKER_ID_RE),
    rows: z.number().int().min(1).max(500),
    cols: z.number().int().min(1).max(500),
  })
  .strict();

export const confirmTerminalTaskSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(500).nullable().optional(),
    workerId: z.string().regex(WORKER_ID_RE),
    outcome: z.enum(['done', 'failed']),
    summary: z.string().trim().min(1).max(20_000),
  })
  .strict();

export interface WorkerPtyDataEvent {
  workerId: string;
  data: string; // base64
}

export interface WorkerPtyExitEvent {
  workerId: string;
  exitCode: number | null;
}

interface Attachment {
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
  limiter: PtyInputLimiter;
}

export function registerWorkerPtyIpc(ctx: IpcContext): void {
  const mainOnly = mainWindowSenderPolicy(
    () => ctx.liveWindow()?.webContents.id ?? null,
  );
  const mainOnlyError = 'Sender is not the main window';
  const attachments = new Map<string, Attachment>();

  const detach = (workerId: string): void => {
    const att = attachments.get(workerId);
    if (!att) return;
    att.unsubscribeData();
    att.unsubscribeExit();
    attachments.delete(workerId);
  };

  handleSecure('worker-pty:attach', {
    schema: workerPtyAttachSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      const host = getPtyHost();
      const { workerId } = payload;
      if (!host.has(workerId)) {
        return { ok: false, error: 'No live PTY for this worker' };
      }
      // Re-attach replaces the previous subscription (renderer remounts).
      detach(workerId);
      const send = (channel: string, data: unknown) => {
        ctx.liveWindow()?.webContents.send(channel, data);
      };
      const unsubscribeData = host.onData(workerId, (data) => {
        send('worker-pty:data', {
          workerId,
          data: Buffer.from(data, 'utf8').toString('base64'),
        } satisfies WorkerPtyDataEvent);
      });
      const unsubscribeExit = host.onExit(workerId, (exitCode) => {
        detach(workerId);
        send('worker-pty:exit', { workerId, exitCode } satisfies WorkerPtyExitEvent);
      });
      attachments.set(workerId, {
        unsubscribeData,
        unsubscribeExit,
        limiter: new PtyInputLimiter(),
      });
      const replay = host.replayBuffer(workerId);
      return { ok: true, replay: replay ? replay.toString('base64') : '' };
    },
  });

  handleSecure('worker-pty:input', {
    schema: workerPtyInputSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      const att = attachments.get(payload.workerId);
      if (!att) return { ok: false, error: 'Not attached to this worker PTY' };
      if (!att.limiter.allow(Buffer.byteLength(payload.data, 'utf8'))) {
        return { ok: false, error: 'PTY input rate/size limit exceeded', dropped: true };
      }
      const ok = getPtyHost().write(payload.workerId, payload.data);
      return ok ? { ok: true } : { ok: false, error: 'No live PTY for this worker' };
    },
  });

  handleSecure('worker-pty:resize', {
    schema: workerPtyResizeSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      const ok = getPtyHost().resize(payload.workerId, payload.rows, payload.cols);
      return ok ? { ok: true } : { ok: false, error: 'No live PTY for this worker' };
    },
  });

  handleSecure('worker-pty:detach', {
    schema: workerPtyAttachSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      detach(payload.workerId);
      return { ok: true };
    },
  });

  // Terminal workers have no machine-readable report channel: the user
  // decides the outcome. 「标记完成」 synthesizes a minimal WorkReport and
  // rides the normal delivery pipeline (verify → review → acceptance);
  // 「标记失败」 rides the normal failed-signal path.
  handleSecure('scheduler:confirm-terminal-task', {
    schema: confirmTerminalTaskSchema,
    authorize: mainOnly,
    authorizeError: mainOnlyError,
    handler: (payload) => {
      const orchestrator = ctx.getOrchestrator(payload.sessionId);
      if (!orchestrator) return { ok: false, error: 'No active meeting session' };
      if (payload.outcome === 'failed') {
        return orchestrator.failWorkerFromUser(payload.workerId, payload.summary);
      }
      orchestrator.submitWorkerReport(payload.workerId, {
        status: 'completed',
        summary: payload.summary,
        files: [],
        tests: [],
        unresolved: [],
      });
      return { ok: true };
    },
  });
}
