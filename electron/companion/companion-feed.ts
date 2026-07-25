// companion-feed.ts — orchestrator event stream → CompanionModel + AhaBar
// snapshot → point-to-point pushes to the floating window.
//
// Bubbles still come from the same assistant text the meeting transcript /
// TTS is built from. AhaBar additionally tracks pending permission payloads
// so the virtual keyboard can resolve them without round-tripping through
// the main renderer.

import { clipboard, ipcMain } from 'electron';
import { z } from 'zod';
import type { IpcContext, IpcEmittedEvent } from '../ipc/context.js';
import { getSettings, updateSettings } from '../store.js';
import { boardableObservedSessions } from '../observe/board-visibility.js';
import type {
  ClientKind,
  ObservedActivity,
  ObservedSnapshot,
  ObservedState,
} from '../observe/types.js';
import {
  classifyApprovalGesture,
  compareApprovalPriority,
  summarizeApprovalTarget,
  type ApprovalGesture,
} from '../approval-gesture.js';
import {
  CompanionModel,
  type CompanionEvent,
  type CompanionState,
} from './companion-model.js';
import {
  focusMainWindow,
  getCompanionWebContentsId,
  sendToCompanion,
  setAhaBarExpanded,
  setAhaBarGhost,
  toggleCompanionWindow,
} from './companion-window-manager.js';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from '../ipc/validators.js';

export interface AhaBarPending {
  id: string;
  sessionId: string;
  hostId: string;
  source: string;
  toolName: string;
  target: string;
  risk: ApprovalGesture;
  arrivedAt: number;
}

/** One externally-launched CLI session surfaced on the bar. Read-only: the
 *  only action is copying the client's own resume command (S0 observation
 *  layer has no approve/input path). */
export interface AhaBarObserved {
  id: string;
  clientKind: ClientKind;
  projectName: string;
  title: string;
  state: ObservedState;
  activity: ObservedActivity;
  lastActiveAt: number;
}

export interface AhaBarState {
  sessionId: string | null;
  cwd: string | null;
  projectName: string | null;
  runningCount: number;
  pending: AhaBarPending[];
  /** Highest-priority pending — the virtual keyboard's sole target. */
  topPending: AhaBarPending | null;
  hardwareTakenOver: boolean;
  /** Top boardable observed sessions (waiting first, then recency). */
  observed: AhaBarObserved[];
}

/** Observed rows the bar has room for. */
const AHABAR_OBSERVED_MAX = 3;

/** The client's own terminal command to resume an observed session. Kimi
 *  multi-turn resume is `--session <id>` (see backends/kimi-adapter.ts
 *  buildKimiCommandArgs), not a `resume` subcommand. */
export function buildObservedResumeCommand(
  clientKind: ClientKind,
  nativeSessionId: string,
): string {
  switch (clientKind) {
    case 'claude-code':
      return `claude --resume ${nativeSessionId}`;
    case 'codex':
      return `codex resume ${nativeSessionId}`;
    case 'kimi':
      return `kimi --session ${nativeSessionId}`;
  }
}

function projectNameFromCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export class CompanionFeed {
  private readonly model = new CompanionModel();
  private activeSessionId: string | null = null;
  private pendingById = new Map<string, AhaBarPending>();
  private runningCount = 0;
  private observedTop: AhaBarObserved[] = [];
  /** Resume command per surfaced observed id — looked up on copy so the
   *  nativeSessionId never has to ride the AhaBar wire shape. */
  private resumeCommandById = new Map<string, string>();

  constructor(private readonly ctx: IpcContext) {}

  /** Tap point — called from main.ts emitToRenderer for every event. */
  onOrchestratorEvent(e: IpcEmittedEvent): void {
    const now = Date.now();
    const activeId = this.ctx.registry.getActiveId();
    if (this.activeSessionId !== activeId) {
      // Follow the active meeting tab: reset the room on a switch.
      this.activeSessionId = activeId;
      this.model.reset();
      this.pendingById.clear();
      this.runningCount = 0;
      this.refreshRoster(now);
      this.push(now);
    }
    if (!activeId || e.sessionId !== activeId) return;

    this.ingestPermission(e, now);

    const mapped = mapOrchestratorEvent(e);
    if (mapped === 'roster') {
      this.refreshRoster(now);
    } else if (mapped) {
      this.model.ingest(mapped, now);
    }
    this.refreshRunningCount();
    this.push(now);
  }

  onTtsState(active: boolean): void {
    this.model.setTtsActive(active);
    this.push(Date.now());
  }

  /** Tap point — called from main.ts for every ObserveService snapshot. */
  onObservedSnapshot(snapshot: ObservedSnapshot): void {
    const now = Date.now();
    const top = boardableObservedSessions(snapshot.sessions, now)
      .slice(0, AHABAR_OBSERVED_MAX);
    this.observedTop = top.map((s) => ({
      id: s.id,
      clientKind: s.clientKind,
      projectName: s.projectName,
      title: s.title,
      state: s.state,
      activity: s.activity,
      lastActiveAt: s.lastActiveAt,
    }));
    this.resumeCommandById = new Map(
      top.map((s) => [s.id, buildObservedResumeCommand(s.clientKind, s.nativeSessionId)]),
    );
    this.push(now);
  }

  /** Copy the observed session's client resume command to the clipboard. */
  copyResumeCommand(id: string): { ok: boolean; error?: string } {
    const command = this.resumeCommandById.get(id);
    if (!command) return { ok: false, error: 'Unknown observed session' };
    clipboard.writeText(command);
    return { ok: true };
  }

  getState(): CompanionState {
    return this.model.state(Date.now());
  }

  getAhaBarState(): AhaBarState {
    return this.buildAhaBarState();
  }

  resolvePermission(id: string, decision: 'allow' | 'deny'): { ok: boolean; error?: string } {
    const pending = this.pendingById.get(id);
    const sessionId = pending?.sessionId ?? this.activeSessionId;
    const orch = this.ctx.getOrchestrator(sessionId);
    if (!orch) return { ok: false, error: 'No active session' };
    orch.resolvePermission(id, decision);
    this.pendingById.delete(id);
    this.push(Date.now());
    return { ok: true };
  }

  private ingestPermission(e: IpcEmittedEvent, now: number): void {
    const hostId = e.hostId ?? 'default';
    const ev = e.event as { kind: string } & Record<string, unknown>;
    if (ev.kind === 'permission-request') {
      const id = typeof ev.id === 'string' ? ev.id : null;
      const toolName = typeof ev.toolName === 'string' ? ev.toolName : null;
      if (!id || !toolName) return;
      const input = (ev.input && typeof ev.input === 'object'
        ? ev.input
        : {}) as Record<string, unknown>;
      const risk = classifyApprovalGesture(toolName, input);
      this.pendingById.set(id, {
        id,
        sessionId: e.sessionId,
        hostId,
        source: typeof e.source === 'string' ? e.source : hostId,
        toolName,
        target: summarizeApprovalTarget(toolName, input),
        risk,
        arrivedAt: now,
      });
      return;
    }
    if (ev.kind === 'permission-cancelled') {
      const id = typeof ev.id === 'string' ? ev.id : null;
      if (id) this.pendingById.delete(id);
    }
  }

  private refreshRunningCount(): void {
    // CompanionModel already tracks per-host working/stalled/alert seats from
    // the same event stream — reuse that rather than reaching into the
    // private meetingScheduler.
    const state = this.model.state(Date.now());
    this.runningCount = state.participants.filter((p) =>
      !p.vacated && (p.status === 'working' || p.status === 'stalled' || p.status === 'alert'),
    ).length;
  }

  private buildAhaBarState(): AhaBarState {
    const cwd = this.ctx.getCurrentCwd(this.activeSessionId);
    const pending = [...this.pendingById.values()].sort(compareApprovalPriority);
    return {
      sessionId: this.activeSessionId,
      cwd,
      projectName: projectNameFromCwd(cwd),
      runningCount: this.runningCount,
      pending,
      topPending: pending[0] ?? null,
      hardwareTakenOver: false,
      observed: this.observedTop,
    };
  }

  private refreshRoster(now: number): void {
    const orch = this.ctx.getOrchestrator(this.activeSessionId);
    this.model.setRoster(orch?.listHosts() ?? [], now);
  }

  private push(now: number): void {
    sendToCompanion('companion:event', this.model.state(now));
    sendToCompanion('ahabar:event', this.buildAhaBarState());
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
    schema: z.object({
      view: z.enum(['ahabar', 'companion']).optional(),
    }).strict().nullish(),
    authorize: mainWindowOnly,
    handler: (payload) => ({
      ok: true,
      ...toggleCompanionWindow(payload?.view ?? 'ahabar'),
    }),
  });

  handleSecure('companion:get-state', {
    schema: emptyPayloadSchema,
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: () => ({ ok: true, state: feed!.getState() }),
  });

  handleSecure('ahabar:get-state', {
    schema: emptyPayloadSchema,
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: () => ({ ok: true, state: feed!.getAhaBarState() }),
  });

  handleSecure('ahabar:resolve-permission', {
    schema: z.object({
      id: z.string().min(1),
      decision: z.enum(['allow', 'deny']),
    }).strict(),
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: (payload) => feed!.resolvePermission(payload.id, payload.decision),
  });

  handleSecure('ahabar:focus-main', {
    schema: emptyPayloadSchema,
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: () => ({ ok: focusMainWindow(() => ctx.liveWindow()) }),
  });

  handleSecure('ahabar:copy-resume', {
    schema: z.object({
      id: z.string().min(1),
    }).strict(),
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: (payload) => feed!.copyResumeCommand(payload.id),
  });

  handleSecure('ahabar:set-expanded', {
    schema: z.object({ expanded: z.boolean() }).strict(),
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: (payload) => ({ ok: setAhaBarExpanded(payload.expanded) }),
  });

  handleSecure('ahabar:set-ghost', {
    schema: z.object({ ghost: z.boolean() }).strict(),
    authorize: companionWindowOnly,
    authorizeError: 'Sender is not the companion window',
    handler: (payload) => ({ ok: setAhaBarGhost(payload.ghost) }),
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
