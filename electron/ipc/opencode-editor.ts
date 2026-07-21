// opencode-editor.ts — IPC handlers for OpenCode editor windows.
//
// Hardening over the original pass-through version (all channels registered
// via the validators.ts handleSecure gate):
//  - All payloads validated with zod (strict — unknown keys rejected).
//  - `open` only accepts calls from the main window's webContents (a
//    compromised editor/popout renderer cannot spawn new windows).
//  - `open`'s cwd must match a LIVE meeting slot's cwd (SessionRegistry
//    findByCwd) — the renderer cannot point an editor at an arbitrary
//    directory.

import { z } from 'zod';
import {
  createOpenCodeEditorWindow,
  closeOpenCodeEditorWindow,
  listOpenCodeEditorWindows,
} from '../opencode-window-manager.js';
import type { IpcContext } from './context.js';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from './validators.js';

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

export function registerOpenCodeEditorIpc(ctx: IpcContext): void {
  handleSecure('opencode-editor:open', {
    schema: openCodeEditorOpenPayloadSchema,
    authorize: mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null),
    handler: (payload) => {
      // cwd whitelist: must be the cwd of a live meeting slot.
      if (!ctx.registry.findByCwd(payload.cwd)) {
        return { ok: false, error: 'cwd is not a live meeting workspace' };
      }
      createOpenCodeEditorWindow(payload);
      return { ok: true };
    },
  });

  handleSecure('opencode-editor:close', {
    schema: openCodeEditorHostPayloadSchema,
    handler: (payload) => {
      closeOpenCodeEditorWindow(payload.hostId);
      return { ok: true };
    },
  });

  handleSecure('opencode-editor:list', {
    schema: emptyPayloadSchema,
    handler: () => ({ ok: true, windows: listOpenCodeEditorWindows() }),
  });
}
