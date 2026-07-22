// ide-registry.ts IPC — IDE catalog state + default/override management.
// Main-window only (Settings panel); every payload zod-validated via the
// validators.ts handleSecure gate.

import { z } from 'zod';
import { getIdeRegistry } from '../ide/ide-registry.js';
import type { IpcContext } from './context.js';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from './validators.js';

const ideIdSchema = z.string().min(1).max(64);

export const ideRegistrySetDefaultSchema = z.object({ id: ideIdSchema }).strict();

export const ideRegistrySetOverrideSchema = z
  .object({ hostId: z.string().min(1).max(128), ideId: ideIdSchema.nullable() })
  .strict();

export function registerIdeRegistryIpc(ctx: IpcContext): void {
  const mainWindowOnly = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);

  handleSecure('ide-registry:list', {
    schema: emptyPayloadSchema,
    authorize: mainWindowOnly,
    handler: async () => {
      const registry = getIdeRegistry();
      await registry.init();
      return { ok: true, state: registry.getState() };
    },
  });

  handleSecure('ide-registry:set-default', {
    schema: ideRegistrySetDefaultSchema,
    authorize: mainWindowOnly,
    handler: async (payload) => {
      const registry = getIdeRegistry();
      await registry.init();
      return registry.setDefault(payload.id);
    },
  });

  handleSecure('ide-registry:set-override', {
    schema: ideRegistrySetOverrideSchema,
    authorize: mainWindowOnly,
    handler: async (payload) => {
      const registry = getIdeRegistry();
      await registry.init();
      return registry.setOverride(payload.hostId, payload.ideId);
    },
  });
}
