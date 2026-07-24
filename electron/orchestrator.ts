// orchestrator.ts — coordinates M HostGroups (each: 1 Host + N Workers).
//
//   HostGroup "default" (Claude Code, always present)
//     ├── Host (Talker — Haiku-class, meeting-MCP tools, faces the user)
//     └── Workers (0..4, Sonnet-class, full Claude Code preset)
//
//   HostGroup "codex-host" (added via addHost)
//     ├── Host (Codex agent)
//     └── Workers (0..4, Codex sessions)
//
// When only the default HostGroup exists, behavior is identical to the
// pre-multi-host architecture. The public API is unchanged.
//
// MCP tool callbacks for both roles live in `meeting-mcp.ts` and reach back
// here through the `OrchestratorBridge` interface this class implements.
// Recap (post-meeting Haiku summarisation) lives in `recap.ts`. Per-worker
// scheduling, spawn / dispose / DAG cascades, file-collision tracking, and
// the bursty worker→talker update queue live in `worker-scheduler.ts` —
// this file owns the coordination layer and delegates all per-host mechanics
// to HostGroup.

import { randomUUID } from 'node:crypto';
import { ClaudeSession, type SessionEvent } from './claude-session.js';
import type { BackendSession, BackendSessionSnapshot } from './backends/cli-backend.js';
import { getBackendRegistry } from './backends/registry.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import type { PlanMeetingTask } from './meeting-tools.js';
import {
  DecisionWatcher,
  createDecisionDoc,
  type CreateDecisionPayload,
  type ResolvedDecision,
} from './decisions.js';
import {
  appendEntry,
  computeProjectId,
  type MemoryCategory,
} from './memory.js';
import { getBackendAuth, getSettings } from './store.js';
import { homedir } from 'node:os';
import {
  SAVE_MEMORY_PER_SESSION_LIMIT,
  extractText,
} from './orchestrator-helpers.js';
import {
  type DecisionCreationResult,
  type OrchestratorBridge,
  type SaveMemoryResult,
  type SteerResult,
} from './meeting-mcp.js';
import { BrowserTabManager } from './browser-tab-manager.js';
import { startRecap, type RecapHandle } from './recap.js';
import { type SessionFactory, type WorkerScheduler } from './worker-scheduler.js';
import { ensureDir, maybeAppendGitignore } from './attachments/workspace.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { HostGroup } from './host-group.js';
import { CrossHostBus } from './cross-host-bus.js';
import { MeetingRepository } from './meeting-repository.js';
import { authorizeMeetingCommand, type MeetingCommandResult } from './meeting-command.js';
import { TaskWorkspaceManager } from './task-workspace.js';
import { DiagnosticLogger } from './diagnostic-logger.js';
import type {
  MeetingPlan,
  MeetingPlanNode,
  OrchestratorEvent,
  OrchestratorSource,
  WorkerSpecialtyKind,
  WorkerStatusKind,
} from './orchestrator-types.js';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type {
  OrchestratorEvent,
  OrchestratorSource,
  MeetingPlan,
  MeetingPlanNode,
  WorkerStatusKind,
  WorkerSpecialtyKind,
} from './orchestrator-types.js';

/** Default host group id. Always present in every meeting. */
const DEFAULT_HOST_ID = 'default';
const DEFAULT_BACKEND_ID = 'claude-code';

interface OrchestratorOpts {
  emit: (e: OrchestratorEvent) => void;
  cwd: string;
  autoApproveScope?: AutoApproveScope;
  workerEnv?: NodeJS.ProcessEnv;
  /** Model override for the talker session. When unset the talker defaults to
   *  Haiku for latency; a custom gateway/model (ANTHROPIC_MODEL) is threaded
   *  here so the talker doesn't request a model the gateway can't serve. */
  talkerModel?: string;
  /** Optional override for ClaudeSession construction. Production code leaves
   *  this unset; tests inject a stub so cleanup paths can run without
   *  spawning the real Claude CLI subprocess. */
  sessionFactory?: SessionFactory;
  /** S3: native OS confirmer for destructive tool calls when auto-approve is
   *  on. Main wires this to dialog.showMessageBox so a compromised renderer
   *  cannot fake the approval. Threaded through to every ClaudeSession. */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Optional browser tab manager for embedded browser MCP tools. When
   *  provided, all workers get browser_navigate/screenshot/click/type tools. */
  browserTabManager?: BrowserTabManager;
  /** Backend ID for the default host group. Defaults to 'claude-code'. */
  defaultBackendId?: string;
  /** Existing Meeting identity and native Host handles selected by the user for recovery. */
  meetingId?: string;
  recoverySeq?: number;
  resumeBackendSessions?: Record<string, BackendSessionSnapshot>;
  recoveredTasks?: Array<Record<string, unknown>>;
}

export class Orchestrator implements OrchestratorBridge {
  /** All host groups in this meeting. Always has at least 'default'. */
  private hostGroups = new Map<string, HostGroup>();
  /** The single host allowed to coordinate user input and plan mutations. */
  private coordinatorHostId = DEFAULT_HOST_ID;
  /** Single authoritative task graph and worker pool for the whole Meeting. */
  private meetingScheduler!: WorkerScheduler;
  private emit: (e: OrchestratorEvent) => void;
  private cwd: string;
  private autoApproveScope: AutoApproveScope;
  private workerEnv: NodeJS.ProcessEnv | undefined;
  private talkerModel: string | undefined;
  private confirmDestructive: ((toolName: string, input: Record<string, unknown>) => Promise<boolean>) | undefined;
  private browserTabManager: BrowserTabManager | undefined;
  private closed = false;
  private projectId: string;
  private meetingId: string;
  private repository: MeetingRepository;
  private workspaceManager: TaskWorkspaceManager;
  private diagnostics: DiagnosticLogger;
  private resumeBackendSessions: Record<string, BackendSessionSnapshot>;
  private recoveredTasks: Array<Record<string, unknown>>;
  private saveMemoryCallsThisSession = 0;
  private autoOrchestration = false;
  private pendingPlan: PlanMeetingTask[] | null = null;
  // Active end-of-meeting recap, if any. Tracked so `interrupt()` can reach
  // into a closed orchestrator and abort the recap pass (B4) — otherwise
  // the user pressing the interrupt button after `end()` was a no-op while
  // Haiku continued to chew through the transcript.
  private recapHandle: RecapHandle | null = null;
  private sessionFactory: SessionFactory;
  // Async decision side-channel. Each open decision has a fs.watch entry that
  // fires onDecisionResolved() when the user fills in "✅ 确认结论". Cleaned up
  // in end().
  private decisions: DecisionWatcher = new DecisionWatcher();
  private decisionMeta: Map<string, { question: string; path: string }> = new Map();

  // Cross-host messaging bus. Each HostGroup subscribes on creation; the
  // orchestrator publishes when cross-host events occur (file writes, decision
  // resolutions, etc.).
  private crossHostBus = new CrossHostBus();

  // Cached in-flight `end()` Promise. Subsequent calls return the same Promise
  // so callers can `await orchestrator.end()` repeatedly without re-running
  // teardown. Distinct from `this.closed` so we can both gate the work AND
  // surface the async cleanup tail (recap) to a waiting before-quit handler.
  private endPromise: Promise<void> | null = null;

  // Process-level fallback: if main.ts forgets (or crashes) before its own
  // before-quit / window-all-closed hooks fire, `process.exit` still gives us
  // one synchronous chance to release native resources held by live workers.
  private static liveInstances: Set<Orchestrator> = new Set();
  private static shutdownHookInstalled = false;

  private static ensureShutdownHook() {
    if (Orchestrator.shutdownHookInstalled) return;
    Orchestrator.shutdownHookInstalled = true;
    const handler = () => {
      for (const inst of Orchestrator.liveInstances) {
        try { inst.end(); } catch { /* ignore */ }
      }
      Orchestrator.liveInstances.clear();
    };
    // 'exit' is sync-only and last-ditch; that's the right shape for "kill
    // anything still alive on the way out". We deliberately don't grab
    // SIGINT/SIGTERM — Electron owns those and would route them through its
    // own quit lifecycle, where main.ts's before-quit handler runs end()
    // for us via the normal path.
    process.once('exit', handler);
  }

  constructor(opts: OrchestratorOpts) {
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.autoApproveScope = opts.autoApproveScope ?? 'off';
    this.workerEnv = opts.workerEnv;
    this.talkerModel = opts.talkerModel;
    this.confirmDestructive = opts.confirmDestructive;
    this.browserTabManager = opts.browserTabManager;
    this.projectId = computeProjectId(this.cwd);
    this.meetingId = opts.meetingId ?? randomUUID();
    this.resumeBackendSessions = opts.resumeBackendSessions ?? {};
    this.recoveredTasks = opts.recoveredTasks ?? [];
    this.repository = new MeetingRepository(this.meetingId, opts.recoverySeq);
    this.workspaceManager = new TaskWorkspaceManager(this.meetingId, this.cwd);
    this.diagnostics = new DiagnosticLogger(this.meetingId);
    void this.repository.append(opts.meetingId ? 'meeting-recovered' : 'meeting-created', { cwd: this.cwd });
    this.sessionFactory = opts.sessionFactory ?? Orchestrator.defaultClaudeFactory;

    // Create the default HostGroup. Use the user's preferred backend if specified.
    const defaultBackend = opts.defaultBackendId ?? DEFAULT_BACKEND_ID;
    const defaultBackendAdapter = getBackendRegistry().get(defaultBackend);
    if (!defaultBackendAdapter) throw new Error(`backend '${defaultBackend}' is not registered`);
    if (!defaultBackendAdapter.capabilities.coordinate) {
      throw new Error(`backend '${defaultBackend}' cannot coordinate`);
    }
    this.createHostGroup(DEFAULT_HOST_ID, defaultBackend);

    Orchestrator.liveInstances.add(this);
    Orchestrator.ensureShutdownHook();
  }

  // ---------------------------------------------------------------------------
  // HostGroup management

  /** Build a SessionFactory only after the selected backend passes its role gate. */
  private buildSessionFactory(
    backendId: string,
    actorHostId = DEFAULT_HOST_ID,
    purpose: 'host' | 'worker' = 'host',
  ): SessionFactory {
    const backend = getBackendRegistry().get(backendId);
    if (!backend) throw new Error(`backend '${backendId}' is not registered`);
    if (purpose === 'worker' && !backend.capabilities.executeTasks) {
      throw new Error(`backend '${backendId}' cannot execute delivery tasks`);
    }
    // If a test-injected factory is set, use it for all backends.
    if (this.sessionFactory !== Orchestrator.defaultClaudeFactory) {
      return this.sessionFactory;
    }
    // Wrap the adapter's createSession to accept ClaudeSession-shaped opts,
    // translating the fields that differ between the two interfaces.
    return (opts) => {
      const so = opts.sessionOptions ?? {};
      let systemPrompt: string | undefined;
      if (typeof so.systemPrompt === 'string') {
        systemPrompt = so.systemPrompt;
      } else if (so.systemPrompt && typeof so.systemPrompt === 'object' && 'append' in so.systemPrompt) {
        systemPrompt = (so.systemPrompt as { append?: string }).append;
      }
      if (backendId === 'codex') {
        systemPrompt = `${systemPrompt ?? ''}\n\n## AhaStation command protocol\n`
          + 'When you need to coordinate, emit exactly one fenced JSON block using ```meeting-command. '
          + 'Supported kinds are propose-plan, ask-host, broadcast-hosts, steer-worker, and speak. '
          + 'Do not claim a command succeeded until the application returns its result.';
      }
      const authEntry = getBackendAuth(backendId);
      const auth = authEntry
        ? {
            authMode: authEntry.authMode,
            apiKey: authEntry.apiKey,
            baseUrl: authEntry.baseUrl,
            model: authEntry.model,
          }
        : { authMode: 'none' as const };
      // Claude's bundled-defaults feature redirects HOME to a shadow tree.
      // Every other CLI must retain the real HOME so OAuth/config locations
      // such as ~/.codex remain visible.
      const backendBaseEnv = { ...(opts.envOverride ?? {}) };
      if (backendId !== 'claude-code') {
        backendBaseEnv.HOME = homedir();
        backendBaseEnv.USERPROFILE = homedir();
      }
      const env = backend.buildEnv(auth, backendBaseEnv);
      const requestedModel = typeof so.model === 'string' ? so.model : undefined;
      const model = backendId === 'codex'
        ? (auth.model ?? requestedModel)
        : backendId === 'claude-code'
          ? (auth.model ?? requestedModel ?? backend.capabilities.defaultModel)
          : requestedModel?.startsWith('claude-')
            ? (auth.model ?? backend.capabilities.defaultModel)
            : (auth.model ?? requestedModel ?? backend.capabilities.defaultModel);
      return backend.createSession(
        {
          cwd: opts.cwd,
          systemPrompt,
          model,
          env,
          mcpServers: so.mcpServers as Record<string, unknown> | undefined,
          skills: Array.isArray(so.skills) ? so.skills : undefined,
          autoApproveScope: opts.autoApproveScope,
          confirmDestructive: opts.confirmDestructive,
          hostId: actorHostId,
          meetingId: this.meetingId,
          resumeSessionId: purpose === 'host'
            ? this.resumeBackendSessions[actorHostId]?.sessionId
            : undefined,
          executionRole: purpose,
          extra: {
            ...so,
            ...(backendId === 'codex' ? { codexTransport: 'app-server' } : {}),
            ...(backendId === 'kimi' ? { kimiTransport: 'acp' } : {}),
            meetingCommandHandler: (raw: unknown) => this.executeMeetingCommand(actorHostId, raw),
          },
        },
        // BackendSessionEvent is structurally compatible with SessionEvent
        // (same kind discriminators, NormalizedMessage mirrors SDKMessage shape).
        opts.emit as (e: import('./backends/cli-backend.js').BackendSessionEvent) => void,
      );
    };
  }

  /** Default ClaudeSession factory, used as identity check for test overrides. */
  private static readonly defaultClaudeFactory: SessionFactory =
    (o) => new ClaudeSession(o) as unknown as BackendSession;

  private createHostGroup(id: string, backendId: string): HostGroup {
    const factory = this.buildSessionFactory(backendId, id);
    const hg = new HostGroup({
      id,
      backendId,
      emit: (e) => this.onHostGroupEvent(id, e),
      cwd: this.cwd,
      projectId: this.projectId,
      autoApproveScope: this.autoApproveScope,
      workerEnv: this.workerEnv,
      talkerModel: this.talkerModel,
      confirmDestructive: this.confirmDestructive,
      sessionFactory: factory,
      resolveWorkerSessionFactory: (backendId) => this.buildSessionFactory(
        backendId ?? this.defaultHost().backendId,
        id,
        'worker',
      ),
      browserTabManager: this.browserTabManager,
      bridge: this,
      isClosed: () => this.closed,
      getSpeechFilterMode: () => (getSettings().speechFilterMode === 'off' ? 'off' : 'strict'),
      isCoordinator: () => this.coordinatorHostId === id,
      workspaceManager: id === DEFAULT_HOST_ID && this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? this.workspaceManager
        : undefined,
    });
    this.hostGroups.set(id, hg);
    if (id === DEFAULT_HOST_ID) {
      this.meetingScheduler = hg.getScheduler();
      this.meetingScheduler.setTalkerProvider(() => this.defaultHost().getHost());
    }

    // Subscribe to cross-host messages targeting this group
    this.crossHostBus.subscribe(id, (msg) => {
      const host = hg.getHost();
      if (host) {
        host.sendUserText(`[cross-host from ${msg.from}] ${msg.text}`, 'normal');
      }
    });

    return hg;
  }

  /** Add a new host group to this meeting. Returns the host group id.
   *  The host's talker session is started asynchronously — the renderer shows
   *  a "Connecting…" placeholder until the session-ready event arrives. */
  addHost(backendId: string, hostId?: string): { ok: true; hostId: string } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: 'orchestrator is closed' };
    if (hostId && !/^[a-zA-Z0-9._-]{1,64}$/.test(hostId)) {
      return { ok: false, error: 'hostId must be alphanumeric with dots/hyphens/underscores, max 64 chars' };
    }
    const backend = getBackendRegistry().get(backendId);
    if (!backend) return { ok: false, error: `backend '${backendId}' not found` };
    if (!backend.resolveBinary()) return { ok: false, error: `backend '${backendId}' runtime is not available` };
    this.diagnostics.log('host-add-requested', {
      hostId: hostId ?? null,
      backendId,
      runtimePath: backend.resolveBinary(),
      cwd: this.cwd,
      homeSource: backendId === 'claude-code' ? 'claude-shadow' : 'real-home',
    });
    const id = hostId ?? `${backendId}-host-${this.hostGroups.size}`;
    if (this.hostGroups.has(id)) {
      return { ok: false, error: `host group '${id}' already exists` };
    }
    const hg = this.createHostGroup(id, backendId);

    // Fire-and-forget the talker transport handshake. Starting a Host must not
    // spend a model turn: delayed startup greetings used to surface minutes
    // later as unrelated "welcome back" messages in the live transcript.
    void (async () => {
      try {
        await hg.start();
        if (this.closed) return;
        await this.snapshotActiveMeeting();
        if (!this.closed) {
          this.safeEmit({
            source: 'system',
            hostId: id,
            event: { kind: 'session-ready' },
          });
        }
      } catch (err: unknown) {
        this.diagnostics.log('host-start-failed', {
          hostId: id,
          backendId,
          error: err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : String(err),
        });
        console.error(`[orchestrator] failed to start host '${id}':`, err);
        this.safeEmit({
          source: 'system',
          hostId: id,
          event: {
            kind: 'session-start-failed',
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();

    return { ok: true, hostId: id };
  }

  /** Remove a host group. Cannot remove the default host. */
  removeHost(hostId: string): { ok: true } | { ok: false; error: string } {
    if (hostId === DEFAULT_HOST_ID) {
      return { ok: false, error: 'cannot remove the default host group' };
    }
    if (hostId === this.coordinatorHostId) {
      return { ok: false, error: 'cannot remove the active coordinator; transfer coordination first' };
    }
    const hg = this.hostGroups.get(hostId);
    if (!hg) {
      return { ok: false, error: `host group '${hostId}' not found` };
    }
    hg.end();
    this.hostGroups.delete(hostId);
    this.crossHostBus.unsubscribeHost(hostId);
    return { ok: true };
  }

  /** List all host groups with their ids and backend ids. */
  listHosts(): Array<{
    id: string;
    backendId: string;
    role: 'coordinator' | 'expert';
    backendSession?: BackendSessionSnapshot;
  }> {
    return Array.from(this.hostGroups.entries()).map(([id, hg]) => ({
      id,
      backendId: hg.backendId,
      role: id === this.coordinatorHostId ? 'coordinator' : 'expert',
      backendSession: hg.getHost()?.snapshot?.() ?? undefined,
    }));
  }

  setCoordinator(hostId: string): { ok: true; coordinatorHostId: string } | { ok: false; error: string } {
    const hg = this.hostGroups.get(hostId);
    if (!hg) return { ok: false, error: `host group '${hostId}' not found` };
    if (!hg.isReady()) return { ok: false, error: `host group '${hostId}' is not ready` };
    const backend = getBackendRegistry().get(hg.backendId);
    if (!backend) return { ok: false, error: `backend '${hg.backendId}' not found` };
    if (!backend.capabilities.coordinate) {
      return { ok: false, error: `backend '${hg.backendId}' cannot coordinate yet` };
    }
    const previous = this.coordinatorHostId;
    this.coordinatorHostId = hostId;
    void this.repository.append('coordinator-changed', { previous, current: hostId });
    this.meetingScheduler.setTalkerProvider(() => this.defaultHost().getHost());
    hg.getHost()?.sendUserText(
      `[coordinator handoff] You are now the meeting coordinator. Previous coordinator: ${previous}. `
      + `Current worker state:\n${this.describeWorkers()}`,
      'high',
    );
    this.hostGroups.get(previous)?.getHost()?.sendUserText(
      `[coordinator handoff] You are now an Expert Talker. ${hostId} is the sole Coordinator. `
      + 'Do not schedule or speak for the meeting; answer only direct mentions or coordinator requests.',
      'high',
    );
    return { ok: true, coordinatorHostId: hostId };
  }

  getCoordinatorHostId(): string {
    return this.coordinatorHostId;
  }

  sendHostMessage(fromHostId: string, toHostId: string, text: string): { ok: boolean; error?: string } {
    if (!this.hostGroups.has(fromHostId)) return { ok: false, error: `source host '${fromHostId}' not found` };
    if (!this.hostGroups.has(toHostId)) return { ok: false, error: `target host '${toHostId}' not found` };
    if (text.length === 0 || text.length > 20_000) return { ok: false, error: 'message length is invalid' };
    this.crossHostBus.publish({ from: fromHostId, to: toHostId, text });
    void this.repository.append('host-message', { fromHostId, toHostId, chars: text.length });
    return { ok: true };
  }

  async executeMeetingCommand(hostId: string, raw: unknown): Promise<MeetingCommandResult> {
    const actor = this.hostGroups.get(hostId);
    if (!actor) return { ok: false, code: 'forbidden', error: `host '${hostId}' not found` };
    const authorized = authorizeMeetingCommand(raw, {
      hostId,
      role: hostId === this.coordinatorHostId ? 'coordinator' : 'expert',
    });
    if (!authorized.ok) return authorized;
    const command = authorized.command;
    try {
      switch (command.kind) {
        case 'propose-plan': {
          const result = await this.proposePlan(command.tasks);
          return result.ok
            ? { ok: true, value: { tasks: command.tasks.length } }
            : { ok: false, code: 'execution-failed', error: result.error };
        }
        case 'ask-host': {
          const result = this.sendHostMessage(hostId, command.hostId, command.question);
          return result.ok ? { ok: true } : { ok: false, code: 'execution-failed', error: result.error ?? 'send failed' };
        }
        case 'broadcast-hosts': {
          for (const target of this.hostGroups.keys()) {
            if (target !== hostId) this.sendHostMessage(hostId, target, command.question);
          }
          return { ok: true };
        }
        case 'steer-worker': {
          const result = this.steerWorker(command.workerId, command.addendum);
          return result.ok ? { ok: true, value: result } : { ok: false, code: 'execution-failed', error: result.reason };
        }
        case 'speak':
          this.narrateAssistantLine(command.text);
          return { ok: true };
      }
      return { ok: false, code: 'invalid-command', error: 'unsupported command' };
    } catch (err) {
      return { ok: false, code: 'execution-failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get the default host group (always present). */
  private defaultHost(): HostGroup {
    const hg = this.hostGroups.get(this.coordinatorHostId);
    if (!hg) throw new Error('coordinator host group missing — this is a bug');
    return hg;
  }

  /** Handle events from a HostGroup, tagging with hostId before re-emitting. */
  private onHostGroupEvent(hostId: string, e: OrchestratorEvent) {
    this.safeEmit({ ...e, hostId });
    if (
      hostId !== this.coordinatorHostId
      && e.source === 'talker'
      && e.event.kind === 'message'
    ) {
      const text = extractText(e.event.message);
      if (text) {
        this.sendHostMessage(
          hostId,
          this.coordinatorHostId,
          `[expert response from ${hostId}] ${text.slice(0, 20_000)}`,
        );
      }
    }
    if (
      hostId === this.coordinatorHostId
      && e.source === 'talker'
      && e.event.kind === 'ended'
      && !this.closed
    ) {
      const candidate = Array.from(this.hostGroups.entries()).find(([id, hg]) =>
        id !== hostId
        && hg.isReady()
        && getBackendRegistry().get(hg.backendId)?.capabilities.coordinate === true,
      )?.[0] ?? null;
      this.safeEmit({
        source: 'system',
        event: { kind: 'coordinator-failed', hostId, candidateHostId: candidate },
      });
      void this.repository.append('coordinator-failed', { hostId, candidateHostId: candidate });
    }
  }

  async restartHost(hostId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const hg = this.hostGroups.get(hostId);
    if (!hg) return { ok: false, error: `host '${hostId}' not found` };
    if (hg.getHost()) return { ok: false, error: `host '${hostId}' is already running` };
    try {
      await hg.start();
      this.safeEmit({ source: 'system', hostId, event: { kind: 'session-ready' } });
      return { ok: true };
    } catch (err) {
      this.diagnostics.log('host-restart-failed', {
        hostId,
        backendId: hg.backendId,
        error: err instanceof Error ? { name: err.name, message: err.message, cause: err.cause } : String(err),
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API (delegates to default host for backward compatibility)

  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
    for (const hg of this.hostGroups.values()) {
      hg.setAutoApproveScope(scope);
    }
  }

  private safeEmit(e: OrchestratorEvent) {
    if (this.closed) return;
    // Ensure hostId is always present; default to 'default' when absent.
    if (!e.hostId) e = { ...e, hostId: DEFAULT_HOST_ID };
    void this.repository.append(`event:${e.event.kind}`, e);
    if (
      e.event.kind === 'plan-updated'
      || e.event.kind === 'worker-spawned'
      || e.event.kind === 'worker-ended'
      || e.event.kind === 'coordinator-failed'
    ) {
      void this.snapshotActiveMeeting();
    }
    this.emit(e);
  }

  async start(greeting?: string) {
    await this.defaultHost().start(greeting);
    if (this.recoveredTasks.length > 0) {
      this.emitRecoveredPlan();
    }
    // Persist the native backend handle before the renderer is told the Host
    // is ready. A crash after readiness can then recover the exact thread.
    await this.snapshotActiveMeeting();
  }

  async resolveRecoveredTask(
    taskId: string,
    action: 'continue' | 'retry' | 'complete' | 'abandon',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const index = this.recoveredTasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, error: 'interrupted task not found' };
    const current = this.recoveredTasks[index];
    if (current.status !== 'interrupted' && current.status !== 'running') {
      return { ok: false, error: `task is already ${String(current.status)}` };
    }

    if (action === 'complete' || action === 'abandon') {
      this.recoveredTasks[index] = {
        ...current,
        status: action === 'complete' ? 'done' : 'failed',
      };
      await this.repository.append('recovered-task-resolved', { taskId, action });
      this.emitRecoveredPlan();
      await this.snapshotActiveMeeting();
      return { ok: true };
    }

    const task: PlanMeetingTask = {
      id: String(current.id ?? ''),
      title: String(current.title ?? current.id ?? 'Recovered task'),
      prompt: String(current.prompt ?? ''),
      // An interrupted dependency graph is not silently replayed. A user
      // explicitly resumes each side-effecting task, so this retry is a new
      // independent execution at the same durable task identity.
      deps: [],
      executorBackendId: typeof current.executorBackendId === 'string'
        ? current.executorBackendId
        : undefined,
      writePaths: Array.isArray(current.writePaths) ? current.writePaths.map(String) : undefined,
    };
    if (!task.id || !task.prompt) return { ok: false, error: 'recovered task is missing its id or prompt' };
    const backendError = this.validateExecutionBackends([task]);
    if (backendError) return { ok: false, error: backendError };
    const result = this.meetingScheduler.installPlan([task]);
    if (!result.ok) return result;
    this.recoveredTasks.splice(index, 1);
    await this.repository.append('recovered-task-resolved', { taskId, action });
    await this.snapshotActiveMeeting();
    return { ok: true };
  }

  private emitRecoveredPlan(): void {
    const nodes = this.recoveredTasks.map((task) => ({
      id: String(task.id ?? ''),
      title: String(task.title ?? task.id ?? 'Interrupted task'),
      status: task.status === 'running' ? 'interrupted' : task.status,
      deps: Array.isArray(task.deps) ? task.deps.map(String) : [],
    })).filter((node) => node.id) as MeetingPlanNode[];
    this.safeEmit({ source: 'system', event: { kind: 'plan-updated', plan: { nodes } } });
  }

  private snapshotActiveMeeting(): Promise<void> {
    const liveTasks = this.meetingScheduler.snapshot();
    return this.repository.snapshot({
      status: 'active',
      cwd: this.cwd,
      coordinatorHostId: this.coordinatorHostId,
      hosts: this.listHosts(),
      tasks: liveTasks.length > 0 ? liveTasks : this.recoveredTasks,
      autoOrchestration: this.autoOrchestration,
    });
  }

  sendUserText(text: string) {
    const mention = this.resolveHostMention(text);
    if (!mention) {
      this.defaultHost().sendUserText(text);
      return;
    }
    const addressedText = mention.text || '用户刚刚直接点名了你，请简短回应。';
    mention.host.sendUserText(
      `[direct user mention from meeting chat]\n${addressedText}\n\n`
      + '直接用普通 assistant 文本回答用户；不要主持、派任务或输出 meeting-command。',
    );
    void this.repository.append('user-mentioned-host', {
      hostId: mention.hostId,
      backendId: mention.host.backendId,
      chars: addressedText.length,
    });
  }

  private resolveHostMention(text: string): { hostId: string; host: HostGroup; text: string } | null {
    for (const match of text.matchAll(/@([a-zA-Z0-9._-]+)/g)) {
      const token = match[1].toLowerCase();
      const found = Array.from(this.hostGroups.entries()).find(([id, host]) => (
        id.toLowerCase() === token || host.backendId.toLowerCase() === token
      ));
      if (!found || !found[1].isReady()) continue;
      const start = match.index ?? 0;
      const withoutMention = `${text.slice(0, start)}${text.slice(start + match[0].length)}`
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
      return { hostId: found[0], host: found[1], text: withoutMention };
    }
    return null;
  }

  sendUserImage(content: SDKUserMessage['message']['content']) {
    this.defaultHost().sendUserImage(content);
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string) {
    // Try every active host group; only the one that issued the permission
    // request actually has a matching pending entry.
    for (const hg of this.hostGroups.values()) {
      hg.resolvePermission(id, decision, message);
    }
  }

  /** Live backend session of a meeting host (for IPC accessors that need
   *  adapter-specific optional methods, e.g. the editor snapshot getter). */
  getHostSession(hostId: string): BackendSession | null {
    return this.hostGroups.get(hostId)?.getHost() ?? null;
  }

  /** Journal meeting id — server-registry key component (PTY creation needs
   *  it to acquire the shared server for a meeting tab). */
  getMeetingId(): string {
    return this.meetingId;
  }

  async interrupt() {
    const tasks: Promise<void>[] = [];
    for (const hg of this.hostGroups.values()) {
      tasks.push(hg.interrupt());
    }
    // B4: abort end-of-meeting recap if it's mid-flight. Recap runs after
    // `end()` so an interrupt arriving here may be the only signal to stop.
    if (this.recapHandle) tasks.push(this.recapHandle.abort());
    await Promise.allSettled(tasks);
  }

  /** Returns true if the post-meeting recap is still in flight. Main process
   *  checks this to decide whether to keep the orchestrator reference alive
   *  past `end()` so a follow-up interrupt can still reach it. */
  isRecapActive(): boolean {
    return this.recapHandle?.isActive() ?? false;
  }

  /** Promise that resolves when the post-meeting recap finishes (success,
   *  abort, or failure). Main uses this to clear its held reference once the
   *  recap is no longer reachable. Null if no recap was started. */
  recapDonePromise(): Promise<void> | null {
    return this.recapHandle?.done ?? null;
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    const tasks: Promise<void>[] = [];
    for (const hg of this.hostGroups.values()) {
      tasks.push(hg.setPermissionMode(mode));
    }
    await Promise.all(tasks);
  }

  end(): Promise<void> {
    if (this.endPromise) return this.endPromise;

    // Merge transcripts from all host groups for recap.
    const allTranscripts: import('./orchestrator-types.js').TalkerTurn[] = [];
    for (const hg of this.hostGroups.values()) {
      allTranscripts.push(...hg.getTranscript());
    }

    this.recapHandle = startRecap({
      transcript: allTranscripts,
      cwd: this.cwd,
      env: this.workerEnv,
      projectId: this.projectId,
      meetingId: this.meetingId,
    });

    // Flush any unfinished worker progress into one final talker line so the
    // user isn't left wondering what happened. Done BEFORE closing the gate.
    const dh = this.defaultHost();
    const dhHost = dh.getHost();
    if (dhHost) {
      const finalLines = this.meetingScheduler.collectFinalBufferedLines();
      if (finalLines.length > 0) {
        this.safeEmit({
          source: 'talker',
          event: {
            kind: 'message',
            message: {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: `（会话结束前各 worker 最后动作）\n${finalLines.join('\n')}` }] },
              parent_tool_use_id: null,
              session_id: 'orchestrator-shutdown',
            } as unknown as SDKMessage,
          },
        });
      }
    }

    this.closed = true;

    // End all host groups — wrap in try/finally so cleanup always runs.
    const errors: unknown[] = [];
    for (const hg of this.hostGroups.values()) {
      try { hg.end(); } catch (err) { errors.push(err); }
    }

    this.decisions.dispose();
    this.decisionMeta.clear();
    this.crossHostBus.dispose();
    Orchestrator.liveInstances.delete(this);

    if (errors.length > 0) {
      console.error('[orchestrator] errors during end():', errors);
    }

    // Currently only recap.done is async. If host group teardown grows async
    // cleanup later, push those Promises into this array.
    const cleanupPromises: Promise<void>[] = [
      this.repository.snapshot({
        status: 'ended',
        coordinatorHostId: this.coordinatorHostId,
        hosts: this.listHosts(),
        workers: this.meetingScheduler.describeWorkers(),
      }).then(() => this.repository.flush()),
    ];
    if (this.recapHandle) cleanupPromises.push(this.recapHandle.done);

    this.endPromise = Promise.all(cleanupPromises).then(() => undefined);
    return this.endPromise;
  }

  /** Manual entry point: renderer-side "Plan meeting" button. */
  async installPlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }> {
    const backendError = this.validateExecutionBackends(tasks);
    if (backendError) return { ok: false, error: backendError };
    return this.meetingScheduler.installPlan(tasks);
  }

  async proposePlan(tasks: PlanMeetingTask[]): Promise<{ ok: true } | { ok: false; error: string }> {
    const backendError = this.validateExecutionBackends(tasks);
    if (backendError) return { ok: false, error: backendError };
    if (!this.autoOrchestration) {
      this.pendingPlan = tasks.map((task) => ({ ...task, deps: [...(task.deps ?? [])] }));
      this.safeEmit({ source: 'system', event: { kind: 'plan-proposed', tasks: this.pendingPlan } });
      void this.repository.append('plan-proposed', { tasks: this.pendingPlan });
      return { ok: true };
    }
    return this.meetingScheduler.installPlan(tasks);
  }

  setAutoOrchestration(enabled: boolean): void {
    this.autoOrchestration = enabled;
    void this.repository.append('orchestration-mode-changed', { enabled });
  }

  approvePendingPlan(approved: boolean): { ok: true } | { ok: false; error: string } {
    const tasks = this.pendingPlan;
    this.pendingPlan = null;
    if (!tasks) return { ok: false, error: 'no pending plan' };
    if (!approved) return { ok: true };
    return this.meetingScheduler.installPlan(tasks);
  }

  private validateExecutionBackends(tasks: PlanMeetingTask[]): string | null {
    const defaultBackendId = this.defaultHost().backendId;
    for (const task of tasks) {
      const backendId = task.executorBackendId ?? defaultBackendId;
      const backend = getBackendRegistry().get(backendId);
      if (!backend) return `backend '${backendId}' is not registered`;
      if (!backend.capabilities.executeTasks) {
        return `backend '${backendId}' cannot execute delivery tasks`;
      }
    }
    return null;
  }

  // ===========================================================================
  // OrchestratorBridge — methods called from the MCP tool factories in
  // meeting-mcp.ts. These route to the default host's scheduler. In a full
  // multi-host setup, the bridge would be hostId-aware; for now the default
  // host handles all MCP tool callbacks.

  delegateSingleTask(description: string): { workerId: string; specialty: WorkerSpecialtyKind; reused: boolean } {
    const backendId = this.defaultHost().backendId;
    const backend = getBackendRegistry().get(backendId);
    if (!backend) throw new Error(`backend '${backendId}' is not registered`);
    if (!backend.capabilities.executeTasks) {
      throw new Error(`backend '${backendId}' cannot execute delivery tasks`);
    }
    return this.meetingScheduler.delegateSingleTask(description);
  }

  steerWorker(workerId: string, addendum: string): SteerResult {
    // Search across all host groups — worker IDs are unique.
    return this.meetingScheduler.steerWorker(workerId, addendum);
  }

  hasWorker(workerId: string): boolean {
    return this.meetingScheduler.hasWorker(workerId);
  }

  activeWorkerIds(): string[] {
    return this.meetingScheduler.activeWorkerIds();
  }

  describeWorkers(workerId?: string): string {
    return this.meetingScheduler.describeWorkers(workerId);
  }

  narrateAssistantLine(text: string): void {
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'message',
        message: {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text }] },
          parent_tool_use_id: null,
          session_id: 'orchestrator-narrate',
        } as unknown as SDKMessage,
      },
    });
  }

  async createDecision(payload: CreateDecisionPayload): Promise<DecisionCreationResult> {
    const created = await createDecisionDoc(payload);
    const recommended = payload.options[created.recommendedIndex];
    this.decisionMeta.set(created.id, { question: payload.question, path: created.path });
    this.decisions.watch(created.id, created.path, (r) => this.onDecisionResolved(r));
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'decision-pending',
        decisionId: created.id,
        question: payload.question,
        path: created.path,
        recommendedTitle: recommended?.title ?? '',
        calendarOk: created.calendar.ok,
        remindersOk: created.reminders.ok,
      },
    });
    const sideChannelNote = [
      created.calendar.ok ? 'Calendar ✓' : 'Calendar ✗',
      created.reminders.ok ? 'Reminders ✓' : 'Reminders ✗',
    ].join(' / ');
    return {
      id: created.id,
      path: created.path,
      recommendedTitle: recommended?.title ?? '',
      calendarOk: created.calendar.ok,
      remindersOk: created.reminders.ok,
      sideChannelNote,
    };
  }

  async saveMemory(input: { category: MemoryCategory; content: string; tags: string[] }): Promise<SaveMemoryResult> {
    if (this.saveMemoryCallsThisSession >= SAVE_MEMORY_PER_SESSION_LIMIT) {
      return { ok: false, error: `rate limit reached (${SAVE_MEMORY_PER_SESSION_LIMIT}/session)` };
    }
    this.saveMemoryCallsThisSession += 1;
    const r = await appendEntry({
      category: input.category,
      content: input.content,
      tags: input.tags,
      projectId: this.projectId,
      sourceMeetingId: this.meetingId,
    });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, preview: input.content.slice(0, 40) };
  }

  /** Save a report-mode document to .vibe-docs/ and emit a document-saved
   *  event so the renderer can display it. Filename is derived from date + title. */
  async saveDocument(input: { title: string; content: string; spokenSummary: string }): Promise<{ ok: boolean; filename?: string; error?: string }> {
    try {
      const docsDir = await ensureDir(this.cwd, '.vibe-docs');
      if (!docsDir) return { ok: false, error: 'could not create .vibe-docs directory' };

      const now = new Date();
      const pad2 = (n: number) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
      const safeTitle = input.title
        .replace(/[^a-zA-Z0-9一-鿿\s_-]/g, '')
        .replace(/\s+/g, '-')
        .slice(0, 40);
      const filename = `${dateStr}-${safeTitle}.md`;
      const filePath = path.join(docsDir, filename);

      // Prepend YAML front-matter with title for the renderer to display
      const header = `---\ntitle: ${input.title}\ncreated: ${now.toISOString()}\n---\n\n`;
      await fsp.writeFile(filePath, header + input.content, 'utf8');
      await maybeAppendGitignore(this.cwd, '.vibe-docs');

      // Emit event so the renderer can show the document
      this.safeEmit({
        source: 'talker',
        event: {
          kind: 'document-saved',
          title: input.title,
          filename,
          path: filePath,
        },
      });

      return { ok: true, filename };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[orchestrator] saveDocument failed:', msg);
      return { ok: false, error: msg };
    }
  }

  markWorkerTaskDone(workerId: string, summary: string): void {
    // Search across all host groups.
    this.meetingScheduler.markTaskDone(workerId, summary);
  }

  // Test-only proxy: forward session events to the scheduler for simulation.
  schedulerOnWorkerEvent(workerId: string, e: SessionEvent): void {
    this.meetingScheduler.onWorkerEvent(workerId, e);
  }

  submitWorkerDelivery(workerId: string, files: string[]): void {
    this.meetingScheduler.submitWorkerDelivery(workerId, files);
  }

  // ===========================================================================

  /**
   * Called from DecisionWatcher when the user fills in "✅ 确认结论". Pushes a
   * synthetic system message into the default host's talker so the model can
   * re-evaluate, and surfaces an activity entry to the renderer.
   */
  private onDecisionResolved(r: ResolvedDecision): void {
    if (this.closed) return;
    const meta = this.decisionMeta.get(r.id);
    const question = meta?.question ?? '';
    this.safeEmit({
      source: 'talker',
      event: {
        kind: 'decision-resolved',
        decisionId: r.id,
        question,
        path: r.path,
        conclusion: r.conclusion,
      },
    });
    const condensed = r.conclusion.length > 400 ? `${r.conclusion.slice(0, 398)}…` : r.conclusion;
    this.defaultHost().getHost()?.sendUserText(
      `(decision update) 用户对"${question}"给出了结论：${condensed}\n\n如果这跟你之前推进的方向不一致，请马上调整：可以 delegate_to 现有 worker 让他改，或开新 worker 走另一条路；并简短告诉用户你怎么调整。`,
      'normal',
    );
    this.decisionMeta.delete(r.id);
    this.decisions.unwatch(r.path);

    // Cross-host notification: if other hosts exist, tell them about the decision.
    if (this.hostGroups.size > 1) {
      this.crossHostBus.publish({
        from: DEFAULT_HOST_ID,
        to: '*',
        text: `Decision resolved: "${question}" → ${condensed}`,
        meta: { kind: 'decision-resolved', payload: { decisionId: r.id, question, conclusion: condensed } },
      });
    }
  }
}
