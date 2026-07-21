// validators.ts — the single gate for new IPC channels.
//
// Every new channel registers through `handleSecure`, which enforces the two
// checks the security review mandates, in order:
//   1. sender attribution (`authorize`) — a pure predicate over the sender's
//      webContents id. Two ready-made policies cover the current window
//      population: the main window, and registered OpenCode editor windows.
//   2. payload shape (`schema`) — a strict zod schema; non-objects, missing
//      keys and smuggled extra keys (e.g. a `cwd`) all fail closed.
// Failures from either check return `{ ok: false, error }` and never reach
// the handler. Handler exceptions are caught and collapsed the same way.
//
// The policy factories are pure functions of a sender id (no electron event
// objects), so tests exercise them directly under node --test.

import { ipcMain } from 'electron';
import { z } from 'zod';
import { getEditorEntryByWebContentsId } from '../opencode-window-manager.js';

export type SenderPolicy = (senderId: number) => boolean;

/** Shared schema for channels that take NO payload: undefined/null/{} are
 *  accepted, anything with keys (or a non-object) is rejected. */
export const emptyPayloadSchema = z.object({}).strict().nullish();

function firstIssueMessage(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Invalid payload';
}

/** Pure payload gate, exported so channel modules and tests can use the exact
 *  same validation handleSecure applies. */
export function parsePayload<Schema extends z.ZodType>(
  schema: Schema,
  raw: unknown,
): { ok: true; data: z.output<Schema> } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

/** Policy: only the main window's webContents may invoke. The lookup is
 *  injected so the policy itself stays a pure sender-id predicate. */
export function mainWindowSenderPolicy(
  getMainWebContentsId: () => number | null,
): SenderPolicy {
  return (senderId) => {
    const mainId = getMainWebContentsId();
    return mainId !== null && senderId === mainId;
  };
}

/** Policy: only a registered OpenCode editor window may invoke. The registry
 *  lookup is injectable for tests; by default it hits the live
 *  opencode-window-manager registry. */
export function editorWindowSenderPolicy(
  isRegisteredEditor: (senderId: number) => boolean = (id) =>
    getEditorEntryByWebContentsId(id) !== null,
): SenderPolicy {
  return (senderId) => isRegisteredEditor(senderId);
}

export interface SecureChannelOptions<Schema extends z.ZodType> {
  schema: Schema;
  /** Sender-attribution check, run BEFORE payload validation. Omit only for
   *  channels every renderer may call. */
  authorize?: SenderPolicy;
  /** Error returned when authorize rejects. Defaults to 'Forbidden sender'. */
  authorizeError?: string;
  handler: (payload: z.output<Schema>, senderId: number) => unknown | Promise<unknown>;
}

/** Register an ipcMain.handle behind the schema + sender-attribution gate. */
export function handleSecure<Schema extends z.ZodType>(
  channel: string,
  options: SecureChannelOptions<Schema>,
): void {
  ipcMain.handle(channel, async (event, rawPayload: unknown) => {
    if (options.authorize && !options.authorize(event.sender.id)) {
      return { ok: false, error: options.authorizeError ?? 'Forbidden sender' };
    }
    const parsed = parsePayload(options.schema, rawPayload);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }
    try {
      return await options.handler(parsed.data, event.sender.id);
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
