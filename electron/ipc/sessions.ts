// sessions:* IPC — tab/meeting lifecycle. The renderer drives:
//   sessions:open(cwd, greeting)   → spin up an Orchestrator, register slot
//   sessions:close(id)             → graceful end + drop slot
//   sessions:set-active(id)        → focus a tab (mic/TTS/screen follow)
//   sessions:list                  → current live slots (metadata only)
//   sessions:list-restore          → openTabs + lastActiveCwd from last quit
//
// cwd uniqueness is enforced inside SessionRegistry.open(): if the cwd already
// has a live slot, we return { ok:false, error:'duplicate', sessionId:<existing>}
// and the renderer is expected to switch to that tab instead of opening a new
// one. Lazy restore (renderer hydrates placeholder tabs without spawning
// Orchestrators until clicked) means listRestore returns metadata only.

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fs, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../orchestrator.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { formatError } from '../format-error.js';
import {
  getBackendAuth,
  getSettings,
  pushRecentCwd,
  setOpenTabs,
} from '../store.js';
import type { IpcContext } from './context.js';
import { clearApprovedExternalDirs } from './documents.js';
import { MeetingRepository } from '../meeting-repository.js';
import { getBackendRegistry } from '../backends/registry.js';

interface OpenPayload {
  cwd?: unknown;
  greeting?: unknown;
  backendId?: unknown;
  recoveryMeetingId?: unknown;
}

// Coalesce rapid-fire `setOpenTabs` writes (lobby-restore can fire 5+
// snapshots in 50 ms when the user had several tabs open last quit).
// 100 ms is below human-perceptible latency but easily long enough to fold
// the burst into a single fs write. `before-quit` calls `flushOpenTabsNow`
// to make sure the final state always lands on disk.
const SNAPSHOT_DEBOUNCE_MS = 100;
let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
let snapshotPendingCtx: IpcContext | null = null;

function writeSnapshotNow(ctx: IpcContext): void {
  const tabs = ctx.registry.list().map((s) => ({ cwd: s.cwd, openedAt: s.openedAt }));
  const active = ctx.registry.getActive();
  void setOpenTabs(tabs, active?.cwd ?? null).catch((err) => {
    console.error('[sessions] failed to persist openTabs:', err);
  });
}

function snapshotOpenTabs(ctx: IpcContext): void {
  snapshotPendingCtx = ctx;
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    const pending = snapshotPendingCtx;
    snapshotPendingCtx = null;
    if (pending) writeSnapshotNow(pending);
  }, SNAPSHOT_DEBOUNCE_MS);
}

/** Cancels the pending debounce timer (if any) and writes the latest registry
 *  snapshot synchronously-scheduled (still async on disk). Call sites that
 *  need "this state must hit disk before I return": `sessions:close`,
 *  `before-quit`. */
export function flushOpenTabsNow(ctx: IpcContext): void {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  snapshotPendingCtx = null;
  writeSnapshotNow(ctx);
}

export function registerSessionsIpc(ctx: IpcContext): void {
  ipcMain.handle('sessions:open', async (_e, payload: OpenPayload) => {
    try {
      const rawCwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
      const greeting = typeof payload?.greeting === 'string' ? payload.greeting : undefined;
      const backendId = typeof payload?.backendId === 'string' ? payload.backendId : undefined;
      let selectedBackendId = backendId ?? getSettings().defaultBackend ?? 'claude-code';
      const recoveryMeetingId = typeof payload?.recoveryMeetingId === 'string'
        ? payload.recoveryMeetingId
        : undefined;
      const candidateCwd = rawCwd && rawCwd.length > 0 ? rawCwd : homedir();

      // S8: validate cwd before doing anything. A compromised renderer could
      // pass /etc or any path; verify it exists, is a directory, and is
      // readable by us. Resolve to absolute form so relative segments like
      // "../" don't slip through.
      const resolvedCwd = path.resolve(candidateCwd);
      try {
        const stat = await fs.stat(resolvedCwd);
        if (!stat.isDirectory()) {
          return { ok: false, error: `Invalid cwd: not a directory (${resolvedCwd})` };
        }
        await fs.access(resolvedCwd, fsConstants.R_OK);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `Invalid cwd: ${msg}` };
      }

      let recovery: { meetingId: string; seq: number; state: Record<string, unknown> } | undefined;
      if (recoveryMeetingId) {
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(recoveryMeetingId)) {
          return { ok: false, error: 'Invalid recovery meeting id' };
        }
        recovery = (await MeetingRepository.listRecoverable())
          .find((entry) => entry.meetingId === recoveryMeetingId);
        if (!recovery) return { ok: false, error: 'Recoverable meeting not found' };
        if (path.resolve(String(recovery.state.cwd ?? '')) !== resolvedCwd) {
          return { ok: false, error: 'Recovery workspace does not match the selected folder' };
        }
        const hosts = Array.isArray(recovery.state.hosts) ? recovery.state.hosts : [];
        const defaultHost = hosts.find((host) => (
          typeof host === 'object' && host !== null && (host as { id?: unknown }).id === 'default'
        )) as { backendId?: unknown } | undefined;
        if (typeof defaultHost?.backendId === 'string') selectedBackendId = defaultHost.backendId;
      }

      // cwd uniqueness — bail before constructing an Orchestrator.
      const existing = ctx.registry.findByCwd(resolvedCwd);
      if (existing) {
        ctx.registry.setActive(existing.id);
        snapshotOpenTabs(ctx);
        return { ok: false, error: 'duplicate', sessionId: existing.id, cwd: resolvedCwd };
      }

      const sessionId = randomUUID();
      const backendAuth = getBackendAuth(selectedBackendId);
      const probe = await getBackendRegistry().probe(selectedBackendId, backendAuth
        ? {
            authMode: backendAuth.authMode,
            apiKey: backendAuth.apiKey,
            baseUrl: backendAuth.baseUrl,
            model: backendAuth.model,
          }
        : { authMode: 'none' });
      if (!probe.capabilities.coordinate) {
        return { ok: false, error: `backend '${selectedBackendId}' cannot coordinate` };
      }
      if (!probe.installed) {
        return { ok: false, error: `backend '${selectedBackendId}' runtime is unavailable` };
      }
      if (probe.auth === 'required') {
        return { ok: false, error: `backend '${selectedBackendId}' authentication is required` };
      }
      // Wait for the launch-time shadow-home build the first time. After
      // launch+1 s this resolves immediately; on a manifest-cached relaunch
      // it's effectively instant.
      const shadow = await ctx.awaitClaudeShadowHome();
      const mergedEnv = mergedSubprocessEnv();
      const workerEnv = shadow
        ? { ...mergedEnv, HOME: shadow, USERPROFILE: shadow }
        : undefined;
      // The talker normally runs Haiku for latency; when the user points at a
      // custom gateway/model via ANTHROPIC_MODEL we honor it so the talker
      // doesn't request a model the gateway can't serve.
      const talkerModel = mergedEnv.ANTHROPIC_MODEL || undefined;

      // Pre-bind sessionId into the emit closure so every event this
      // orchestrator emits is automatically routed to the right renderer slot.
      const orch = new Orchestrator({
        emit: (e) => ctx.emitToRenderer({ ...e, sessionId }),
        cwd: resolvedCwd,
        autoApproveScope: ctx.getAutoApprove(),
        workerEnv,
        talkerModel,
        confirmDestructive: ctx.nativeConfirmDestructive,
        browserTabManager: ctx.browserTabManager,
        defaultBackendId: selectedBackendId,
        meetingId: recovery?.meetingId,
        recoverySeq: recovery?.seq,
        resumeBackendSessions: recovery
          ? Object.fromEntries((Array.isArray(recovery.state.hosts) ? recovery.state.hosts : [])
              .filter((host): host is Record<string, unknown> => typeof host === 'object' && host !== null)
              .flatMap((host) => {
                const native = host.backendSession;
                return typeof host.id === 'string'
                  && typeof native === 'object' && native !== null
                  && typeof (native as Record<string, unknown>).sessionId === 'string'
                  && typeof (native as Record<string, unknown>).protocol === 'string'
                  ? [[host.id, native as import('../backends/cli-backend.js').BackendSessionSnapshot]]
                  : [];
              }))
          : undefined,
        recoveredTasks: recovery && Array.isArray(recovery.state.tasks)
          ? recovery.state.tasks.filter((task): task is Record<string, unknown> => typeof task === 'object' && task !== null)
          : undefined,
        recoveredPlanVersion: recovery && typeof recovery.state.planVersion === 'number'
          ? recovery.state.planVersion
          : undefined,
        recoveredReviewSessions: recovery && Array.isArray(recovery.state.reviewSessions)
          ? recovery.state.reviewSessions.filter(
              (session): session is import('../coordinator-review.js').CoordinatorReviewSession => (
                Boolean(session && typeof session === 'object' && !Array.isArray(session))
              ),
            )
          : undefined,
      });

      const result = ctx.registry.open(sessionId, resolvedCwd, orch);
      if (result.kind === 'duplicate') {
        // Race: another open landed between our findByCwd and open. Drop the
        // half-built orchestrator, focus the winner, return duplicate.
        try { orch.end(); } catch { /* ignore */ }
        ctx.registry.setActive(result.existingId);
        snapshotOpenTabs(ctx);
        return { ok: false, error: 'duplicate', sessionId: result.existingId, cwd: resolvedCwd };
      }

      // First slot becomes active automatically inside registry.open(). For
      // subsequent opens we explicitly hand focus to the new tab — matches
      // user expectation that "+ Open another folder" jumps to that tab.
      ctx.registry.setActive(sessionId);

      // Snapshot openTabs immediately so a crash before start completes
      // doesn't lose the tab record. The renderer is told the slot is
      // 'starting' and will gate input until the session-ready event lands.
      snapshotOpenTabs(ctx);

      // Fire-and-forget the SDK spawn. The renderer holds slot.status
      // 'starting' until session-ready/session-start-failed arrives.
      void (async () => {
        try {
          await orch.start(greeting);
          // Slot may have been closed by the user while we were starting —
          // bail without emitting if so (orch.end was already called).
          if (!ctx.registry.get(sessionId)) return;
          ctx.emitToRenderer({
            source: 'system',
            sessionId,
            event: { kind: 'session-ready' },
          });
          // Persist recent + open tab list only after a successful start.
          // Only real user picks land in recents (skip the homedir fallback
          // when the user typed nothing) — otherwise "I never picked
          // anything" becomes indistinguishable from "I last picked my home
          // folder".
          if (rawCwd && rawCwd.length > 0) {
            pushRecentCwd(resolvedCwd).catch((err) => {
              console.error('[settings] failed to persist recentCwds:', err);
            });
          }
          snapshotOpenTabs(ctx);
        } catch (err: unknown) {
          const msg = formatError(err);
          // If the slot was already closed (user bailed), don't bother
          // emitting failed — the renderer no longer has a tab to update.
          const stillOpen = !!ctx.registry.get(sessionId);
          ctx.registry.close(sessionId);
          try { orch.end(); } catch { /* ignore */ }
          if (stillOpen) {
            ctx.emitToRenderer({
              source: 'system',
              sessionId,
              event: { kind: 'session-start-failed', error: `start failed: ${msg}` },
            });
          }
          // Re-snapshot so openTabs no longer lists the dead slot.
          snapshotOpenTabs(ctx);
        }
      })();

      return {
        ok: true,
        sessionId,
        cwd: resolvedCwd,
        backendId: selectedBackendId,
        recovered: Boolean(recovery),
        status: 'starting' as const,
      };
    } catch (err: unknown) {
      const msg = formatError(err);
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('sessions:close', async (_e, payload: { id?: string }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const slot = ctx.registry.get(id);
    if (!slot) return { ok: false, error: 'not-found' };
    try { await slot.orchestrator.end(); } catch { /* ignore */ }
    clearApprovedExternalDirs(id);
    ctx.registry.close(id);
    // Close is the one path where "tab still on disk after close" would be a
    // real bug — tests that re-launch immediately rely on it. Flush rather
    // than debounce.
    flushOpenTabsNow(ctx);
    return { ok: true, activeId: ctx.registry.getActiveId() };
  });

  ipcMain.handle('sessions:set-active', async (_e, payload: { id?: string }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const ok = ctx.registry.setActive(id);
    if (!ok) return { ok: false, error: 'not-found' };
    snapshotOpenTabs(ctx);
    return { ok: true };
  });

  ipcMain.handle('sessions:list', async () => {
    return {
      ok: true,
      sessions: ctx.registry.list(),
      activeId: ctx.registry.getActiveId(),
    };
  });

  ipcMain.handle('sessions:list-restore', async () => {
    const s = getSettings();
    return {
      ok: true,
      openTabs: Array.isArray(s.openTabs) ? s.openTabs : [],
      recentCwds: Array.isArray(s.recentCwds) ? s.recentCwds : [],
      lastActiveCwd: typeof s.lastActiveCwd === 'string' ? s.lastActiveCwd : null,
    };
  });

  ipcMain.handle('sessions:list-recoverable', async () => ({
    ok: true,
    meetings: await MeetingRepository.listRecoverable(),
  }));

  ipcMain.handle('sessions:resolve-recovered-task', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload must be an object' };
    const { sessionId, taskId, action } = payload as Record<string, unknown>;
    if (typeof taskId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(taskId)) {
      return { ok: false, error: 'invalid task id' };
    }
    if (
      action !== 'continue-read-only'
      && action !== 'continue-side-effecting'
      && action !== 'retry-attempt'
      && action !== 'resolve-integration-conflict'
      && action !== 'abandon-task'
    ) {
      return { ok: false, error: 'invalid recovery action' };
    }
    const orch = ctx.getOrchestrator(typeof sessionId === 'string' ? sessionId : null);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.resolveRecoveredTask(taskId, action);
  });

  // ---- Multi-host management -----------------------------------------------

  /** Add a host group to an existing session. The session's Orchestrator
   *  creates a new HostGroup tied to the specified backend. */
  ipcMain.handle('sessions:add-host', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { sessionId, backendId, hostId } = payload as {
      sessionId?: string;
      backendId?: string;
      hostId?: string;
    };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const orch = ctx.getOrchestrator(sessionId);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.addHost(backendId, hostId);
  });

  /** Remove a host group from a session. Cannot remove the default host. */
  ipcMain.handle('sessions:remove-host', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { sessionId, hostId } = payload as { sessionId?: string; hostId?: string };
    if (typeof hostId !== 'string') {
      return { ok: false, error: 'hostId must be a string' };
    }
    const orch = ctx.getOrchestrator(sessionId);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.removeHost(hostId);
  });

  /** List all host groups in a session. */
  ipcMain.handle('sessions:list-hosts', async (_e, payload: unknown) => {
    const sessionId = typeof (payload as { sessionId?: string })?.sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : null;
    const orch = ctx.getOrchestrator(sessionId);
    if (!orch) return { ok: false, error: 'session not found' };
    return { ok: true, hosts: orch.listHosts() };
  });

  ipcMain.handle('sessions:set-coordinator', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload must be an object' };
    const { sessionId, hostId } = payload as { sessionId?: unknown; hostId?: unknown };
    if (typeof hostId !== 'string' || hostId.length === 0) return { ok: false, error: 'hostId is required' };
    const orch = ctx.getOrchestrator(typeof sessionId === 'string' ? sessionId : null);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.setCoordinator(hostId);
  });

  ipcMain.handle('sessions:restart-host', async (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'payload must be an object' };
    const { sessionId, hostId } = payload as { sessionId?: unknown; hostId?: unknown };
    if (typeof hostId !== 'string' || !hostId) return { ok: false, error: 'hostId is required' };
    const orch = ctx.getOrchestrator(typeof sessionId === 'string' ? sessionId : null);
    if (!orch) return { ok: false, error: 'session not found' };
    return orch.restartHost(hostId);
  });
}
