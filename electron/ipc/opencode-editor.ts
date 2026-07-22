// opencode-editor.ts — IPC handlers for IDE editor windows (Phase 3: the
// channel names stay frozen per v1.2 churn control; resolution is now
// IDE-generic via the IdeRegistry).
//
// Hardening over the original pass-through version (all channels registered
// via the validators.ts handleSecure gate):
//  - All payloads validated with zod (strict — unknown keys rejected).
//  - `open` only accepts calls from the main window's webContents (a
//    compromised editor/popout renderer cannot spawn new windows).
//  - `open`'s cwd must match a LIVE meeting slot's cwd (SessionRegistry
//    findByCwd) — the renderer cannot point an editor at an arbitrary
//    directory.
//  - Which IDE backs the window is resolved main-side:
//    perHostOverride[hostId] ?? defaultIdeId (IdeRegistry).

import { z } from 'zod';
import {
  closeEditorWindow,
  listEditorWindows,
  getEditorEntryByWebContentsId,
} from '../ide/ide-window-manager.js';
import { getIdeRegistry } from '../ide/ide-registry.js';
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
    handler: async (payload) => {
      // cwd whitelist: must be the cwd of a live meeting slot.
      if (!ctx.registry.findByCwd(payload.cwd)) {
        return { ok: false, error: 'cwd is not a live meeting workspace' };
      }
      // IDE resolution is main-side: perHostOverride[hostId] ?? defaultIdeId.
      const registry = getIdeRegistry();
      await registry.init();
      const adapter = registry.resolveAdapterForHost(payload.hostId);
      if (!adapter) {
        return { ok: false, error: 'No installed IDE resolved for this host' };
      }
      await adapter.attach(payload);
      return { ok: true };
    },
  });

  handleSecure('opencode-editor:close', {
    schema: openCodeEditorHostPayloadSchema,
    handler: (payload) => {
      closeEditorWindow(payload.hostId);
      return { ok: true };
    },
  });

  handleSecure('opencode-editor:list', {
    schema: emptyPayloadSchema,
    handler: () => ({ ok: true, windows: listEditorWindows() }),
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
