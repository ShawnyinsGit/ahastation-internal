// opencode-editor.ts — IPC handlers for OpenCode editor windows.
//
// Hardening over the original pass-through version:
//  - All payloads validated with zod (strict — unknown keys rejected).
//  - `open` only accepts calls from the main window's webContents (a
//    compromised editor/popout renderer cannot spawn new windows).
//  - `open`'s cwd must match a LIVE meeting slot's cwd (SessionRegistry
//    findByCwd) — the renderer cannot point an editor at an arbitrary
//    directory.

import { ipcMain } from 'electron';
import { z } from 'zod';
import {
  createOpenCodeEditorWindow,
  closeOpenCodeEditorWindow,
  listOpenCodeEditorWindows,
} from '../opencode-window-manager.js';
import type { IpcContext } from './context.js';

const idString = z.string().min(1).max(128);

export const openCodeEditorOpenPayloadSchema = z
  .object({
    hostId: idString,
    backendId: idString,
    sessionId: idString,
    cwd: z.string().min(1).max(4096),
    title: z.string().max(200).optional(),
  })
  .strict();

export const openCodeEditorHostPayloadSchema = z
  .object({ hostId: idString })
  .strict();

function payloadError(err: z.ZodError): string {
  return err.issues[0]?.message ?? 'Invalid payload';
}

export function registerOpenCodeEditorIpc(ctx: IpcContext): void {
  ipcMain.handle('opencode-editor:open', (event, payload: unknown) => {
    // Only the main window may open editor windows.
    const mainWin = ctx.liveWindow();
    if (!mainWin || event.sender.id !== mainWin.webContents.id) {
      return { ok: false, error: 'Forbidden sender' };
    }
    const parsed = openCodeEditorOpenPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: payloadError(parsed.error) };
    }
    // cwd whitelist: must be the cwd of a live meeting slot.
    if (!ctx.registry.findByCwd(parsed.data.cwd)) {
      return { ok: false, error: 'cwd is not a live meeting workspace' };
    }
    try {
      createOpenCodeEditorWindow(parsed.data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('opencode-editor:close', (_event, payload: unknown) => {
    const parsed = openCodeEditorHostPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return { ok: false, error: payloadError(parsed.error) };
    }
    try {
      closeOpenCodeEditorWindow(parsed.data.hostId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('opencode-editor:list', () => {
    try {
      return { ok: true, windows: listOpenCodeEditorWindows() };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
