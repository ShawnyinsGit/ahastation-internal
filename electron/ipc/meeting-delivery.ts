import { ipcMain } from 'electron';
import { z } from 'zod';
import { formatError } from '../format-error.js';
import type { IpcContext } from './context.js';

const sessionIdSchema = z.string().trim().min(1).max(500).nullable().optional();
const identitySchema = z.object({
  sessionId: sessionIdSchema,
  deliveryId: z.string().trim().min(1).max(500),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const reworkSchema = identitySchema.extend({
  reason: z.string().trim().min(1).max(20_000),
}).strict();

export function registerMeetingDeliveryIpc(ctx: IpcContext): void {
  ipcMain.handle('meeting-delivery:get', async (_event, payload: unknown) => {
    const parsed = z.object({ sessionId: sessionIdSchema }).strict().safeParse(payload ?? {});
    if (!parsed.success) return { ok: false, error: 'invalid Meeting delivery request' };
    const slot = ctx.registry.resolve(parsed.data.sessionId);
    if (!slot) return { ok: false, error: 'No active session' };
    try {
      return {
        ok: true,
        delivery: await slot.orchestrator.getMeetingDelivery(),
        decision: slot.orchestrator.getFinalMeetingDecision(),
      };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  });

  ipcMain.handle('meeting-delivery:accept', async (_event, payload: unknown) => {
    const parsed = identitySchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: 'invalid Meeting delivery acceptance' };
    const slot = ctx.registry.resolve(parsed.data.sessionId);
    if (!slot) return { ok: false, error: 'No active session' };
    try {
      return {
        ok: true,
        delivery: await slot.orchestrator.acceptMeetingDelivery(
          parsed.data.deliveryId,
          parsed.data.contentHash,
        ),
      };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  });

  ipcMain.handle('meeting-delivery:request-rework', async (_event, payload: unknown) => {
    const parsed = reworkSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: 'invalid Meeting delivery rework request' };
    const slot = ctx.registry.resolve(parsed.data.sessionId);
    if (!slot) return { ok: false, error: 'No active session' };
    try {
      return {
        ok: true,
        ...await slot.orchestrator.requestMeetingDeliveryRework(
          parsed.data.deliveryId,
          parsed.data.contentHash,
          parsed.data.reason,
        ),
      };
    } catch (error) {
      return { ok: false, error: formatError(error) };
    }
  });
}
