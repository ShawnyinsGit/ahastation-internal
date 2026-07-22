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
  getEditorEntryByWebContentsId,
} from '../opencode-window-manager.js';
import type { IpcContext } from './context.js';
import {
  editorWindowSenderPolicy,
  emptyPayloadSchema,
  handleSecure,
  mainWindowSenderPolicy,
} from './validators.js';

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

  // Editor panel initial state (Phase 2 PR③): the calling editor window gets
  // the snapshot (status / todos / diff / activity) of the OpenCode session
  // bound to ITS hostId. Sender must be a registered editor window — the
  // hostId and meeting slot come from the window registration, never from
  // the payload.
  handleSecure('ide-editor:get-state', {
    schema: emptyPayloadSchema,
    authorize: editorWindowSenderPolicy(),
    authorizeError: 'Sender is not a registered editor window',
    handler: (_payload, senderId) => {
      const entry = getEditorEntryByWebContentsId(senderId);
      if (!entry) {
        return { ok: false, error: 'Sender is not a registered editor window' };
      }
      const slot = ctx.registry.get(entry.options.sessionId);
      const session = slot?.orchestrator.getHostSession(entry.options.hostId);
      const getSnapshot = (session as { getEditorSnapshot?: () => unknown } | null)
        ?.getEditorSnapshot;
      if (!getSnapshot) {
        return { ok: false, error: 'No live OpenCode session for this window' };
      }
      return { ok: true, state: getSnapshot.call(session) };
    },
  });
}
