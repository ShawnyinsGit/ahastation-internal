// companion-feed.ts — orchestrator event stream → CompanionModel →
// point-to-point pushes to the companion window (Phase 8, §3.4).
//
// Data-source decision (per spec ①): bubbles are fed from the SAME
// assistant text the meeting transcript (and thus the TTS) is built
// from — orchestrator 'message' events, which main already sees. That is
// message-granular and naturally rate-limited, unlike the raw event
// firehose; no renderer relay needed for bubble TEXT. The only relay is
// the tiny ttsActive boolean (main-window renderer → main → here), used
// solely to mute companion sounds while the meeting TTS speaks.
//
// Multi-meeting: v1 follows the ACTIVE tab (registry.getActiveId); a tab
// switch resets the room and re-seeds the roster.

import { ipcMain } from 'electron';
import { z } from 'zod';
import type { IpcContext, IpcEmittedEvent } from '../ipc/context.js';
import { getSettings, updateSettings } from '../store.js';
import {
  CompanionModel,
  type CompanionEvent,
  type CompanionState,
} from './companion-model.js';
import {
  getCompanionWebContentsId,
  sendToCompanion,
  toggleCompanionWindow,
} from './companion-window-manager.js';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from '../ipc/validators.js';

export class CompanionFeed {
  private readonly model = new CompanionModel();
  private activeSessionId: string | null = null;

  constructor(private readonly ctx: IpcContext) {}

  /** Tap point — called from main.ts emitToRenderer for every event. */
  onOrchestratorEvent(e: IpcEmittedEvent): void {
    const now = Date.now();
    const activeId = this.ctx.registry.getActiveId();
    if (this.activeSessionId !== activeId) {
      // Follow the active meeting tab: reset the room on a switch.
      this.activeSessionId = activeId;
      this.model.reset();
      this.refreshRoster(now);
      this.push(now);
    }
    if (!activeId || e.sessionId !== activeId) return;

    const mapped = mapOrchestratorEvent(e);
    if (mapped === 'roster') {
      this.refreshRoster(now);
    } else if (mapped) {
      this.model.ingest(mapped, now);
    }
    this.push(now);
  }

  onTtsState(active: boolean): void {
    this.model.setTtsActive(active);
    this.push(Date.now());
  }

  getState(): CompanionState {
    return this.model.state(Date.now());
  }

  private refreshRoster(now: number): void {
    const orch = this.ctx.getOrchestrator(this.activeSessionId);
    this.model.setRoster(orch?.listHosts() ?? [], now);
  }

  private push(now: number): void {
    sendToCompanion('companion:event', this.model.state(now));
  }
}

/** Map a flattened orchestrator event to a model input. 'roster' marks
 *  events that only require a roster reconciliation. NOTE: `permission-
 *  cancelled` rides this stream at runtime (BackendSessionEvent) but is not
 *  declared in the SessionEvent union, so payloads are read defensively
 *  here rather than via TS narrowing. */
function mapOrchestratorEvent(e: IpcEmittedEvent): CompanionEvent | 'roster' | null {
  const hostId = e.hostId ?? 'default';
  const ev = e.event as { kind: string } & Record<string, unknown>;
  switch (ev.kind) {
    case 'message': {
      const msg = ev.message as { type?: string; message?: { content?: unknown } } | undefined;
      if (msg?.type === 'result') return { kind: 'idle-signal', hostId };
      const content = msg?.message?.content;
      if (Array.isArray(content)) {
        const textBlock = content.find(
          (b) => !!b && typeof b === 'object'
            && (b as { type?: unknown }).type === 'text'
            && typeof (b as { text?: unknown }).text === 'string',
        ) as { text: string } | undefined;
        if (textBlock) return { kind: 'text', hostId, text: textBlock.text };
        const toolBlock = content.find(
          (b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use',
        ) as { name?: unknown; input?: unknown } | undefined;
        if (toolBlock) {
          return {
            kind: 'tool',
            hostId,
            toolName: typeof toolBlock.name === 'string' ? toolBlock.name : 'tool',
            input: (toolBlock.input ?? {}) as Record<string, unknown>,
          };
        }
      }
      return null;
    }
    case 'worker-stalled':
      return { kind: 'stalled', hostId };
    case 'worker-ended':
      return {
        kind: 'ended',
        hostId,
        status: ev.status === 'done' ? 'done' : ev.status === 'failed' ? 'failed' : 'interrupted',
      };
    case 'worker-delivery':
      return { kind: 'delivered', hostId };
    case 'permission-request':
      return { kind: 'permission-pending', hostId };
    case 'permission-cancelled':
      return { kind: 'permission-cleared', hostId };
    case 'worker-spawned':
    case 'session-ready':
    case 'plan-updated':
      return 'roster';
    default:
      return null;
  }
}

// ── Singleton + IPC ─────────────────────────────────────────────────────────

let feed: CompanionFeed | null = null;

/** main.ts taps the orchestrator stream through this accessor. */
export function getCompanionFeed(): CompanionFeed | null {
  return feed;
}

export function registerCompanionIpc(ctx: IpcContext): void {
  feed = new CompanionFeed(ctx);
  const mainWindowOnly = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const companionWindowOnly = (senderId: number): boolean =>
    senderId === getCompanionWebContentsId();

  handleSecure('companion:toggle', {
    schema: emptyPayloadSchema,
    authorize: mainWindowOnly,
    handler: () => ({ ok: true, ...toggleCompanionWindow() }),
  });

  handleSecure('companion:get-state', {
    schema: emptyPayloadSchema,
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: () => ({ ok: true, state: feed!.getState() }),
  });

  handleSecure('companion:get-prefs', {
    schema: emptyPayloadSchema,
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: () => ({
      ok: true,
      // Sound defaults ON, user can mute (§3.4 音效策略).
      soundEnabled: getSettings().companionSoundEnabled !== false,
    }),
  });

  handleSecure('companion:set-sound', {
    schema: z.object({ soundEnabled: z.boolean() }).strict(),
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: async (payload) => {
      await updateSettings({ companionSoundEnabled: payload.soundEnabled });
      return { ok: true };
    },
  });

  // ttsActive relay (main window renderer → feed). This is the ONLY piece
  // of renderer-originated input the model takes — bubble text itself comes
  // from orchestrator events, never from the renderer.
  ipcMain.on('companion:tts-state', (event, payload: unknown) => {
    const mainWin = ctx.liveWindow();
    if (!mainWin || event.sender.id !== mainWin.webContents.id) return;
    feed?.onTtsState(Boolean((payload as { active?: unknown })?.active));
  });
}
