// Shared context handed to every IPC domain module. Each ipc/<domain>.ts
// exports a `register<Domain>Ipc(ctx)` function that wires its handlers
// against this context — keeps domain modules pure (no module-level state),
// makes main.ts the single owner of window/auto-approve state, and avoids
// the cross-module-import cycle we'd hit if each domain reached back into
// main.ts directly.
//
// As of the multi-tab refactor, orchestrator/recap/currentCwd are no longer
// global — they live inside `SessionSlot` keyed by `sessionId` inside the
// registry. Handlers take a `sessionId?` (typically `payload.sessionId` from
// the renderer) and call `ctx.registry.resolve(id)` to find the slot; when
// the id is missing, resolve falls back to the active slot for backwards
// compatibility.

import type { BrowserWindow } from 'electron';
import type { AutoApproveScope } from '../auto-approve-policy.js';
import type { Orchestrator, OrchestratorEvent } from '../orchestrator.js';
import type { SessionRegistry, SessionSlot } from '../sessions.js';
import type { BrowserTabManager } from '../browser-tab-manager.js';
import type { ObservedSnapshot } from '../observe/types.js';

/** OrchestratorEvent annotated with the sessionId of the slot that emitted
 *  it. The renderer uses this to route the event to the right MeetingState
 *  in its multi-slot store. */
export type IpcEmittedEvent = OrchestratorEvent & { sessionId: string };

export interface IpcContext {
  liveWindow: () => BrowserWindow | null;
  /** Send a tagged orchestrator event to the renderer. `sessionId` must be
   *  set; main.ts wraps each orchestrator's emit() to pre-bind it. */
  emitToRenderer: (e: IpcEmittedEvent) => void;
  registry: SessionRegistry;
  /** Convenience accessors backed by the registry. id omitted = active slot. */
  getOrchestrator: (sessionId?: string | null) => Orchestrator | null;
  getCurrentCwd: (sessionId?: string | null) => string | null;
  getSlot: (sessionId?: string | null) => SessionSlot | null;
  /** Process-wide auto-approve scope. Currently shared across all slots —
   *  switching one tab's mode switches them all. Kept global so the user
   *  can't be tricked by a backgrounded tab quietly running with elevated
   *  permissions while they think they're in dontask mode in front. */
  getAutoApprove: () => AutoApproveScope;
  setAutoApprove: (v: AutoApproveScope) => void;
  /** Snapshot of the shadow HOME path. May be `null` if the build is still
   *  running on launch — callers that absolutely need the resolved value
   *  must use `awaitClaudeShadowHome()` instead. */
  getClaudeShadowHome: () => string | null;
  /** Resolves to the shadow HOME once the launch-time build finishes.
   *  `sessions:open` awaits this once before spawning the SDK subprocess so
   *  the shadow tree is guaranteed visible. Resolves to `null` in dev mode
   *  or when the build itself failed. */
  awaitClaudeShadowHome: () => Promise<string | null>;
  nativeConfirmDestructive: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<boolean>;
  /** Embedded browser tab manager for MCP browser tools. Optional — when
   *  provided, all workers get browser_navigate/screenshot/click/type tools. */
  browserTabManager?: BrowserTabManager;
  /** Latest observed-session snapshot (main.ts's ObserveService cache).
   *  Threaded into each Orchestrator for the Host observed_session_* tools. */
  getObservedSnapshot: () => ObservedSnapshot;
}
