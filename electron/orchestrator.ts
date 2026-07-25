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
import {
  coerceWorkspaceModeForBaseline,
  normalizeMeetingPlanBrief,
  normalizePlanMeetingTasks,
  type AppliedTaskDefaults,
  type MeetingPlanBrief,
  type MeetingPlanBriefInput,
  type PlanMeetingTask,
  type PlanMeetingTaskInput,
} from './meeting-tools.js';
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
  inferSpecialty,
  titleFromDescription,
} from './orchestrator-helpers.js';
import {
  type ActiveReviewGate,
  type DecisionCreationResult,
  type OrchestratorBridge,
  type SaveMemoryResult,
  type SteerResult,
} from './meeting-mcp.js';
import { BrowserTabManager } from './browser-tab-manager.js';
import { startRecap, type RecapHandle } from './recap.js';
import { type SessionFactory, type WorkerScheduler } from './worker-scheduler.js';
import { ensureDir, maybeAppendGitignore } from './attachments/workspace.js';
import { listAuthorizedAssetReferences } from './attachments/assets.js';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { HostGroup } from './host-group.js';
import { CrossHostBus } from './cross-host-bus.js';
import {
  MeetingRepository,
  type PersistedMeetingEvent,
} from './meeting-repository.js';
import { TaskMailbox } from './task-mailbox.js';
import {
  projectMeetingTasks,
  type TaskProjectionResult,
} from './task-projection.js';
import { DeliveryHarness } from './delivery-harness.js';
import { CommandDeliveryVerifier } from './delivery-verifier.js';
import { DeterministicDeliveryReviewer } from './delivery-reviewer.js';
import { GitDeliveryIntegrator } from './delivery-integrator.js';
import { IntegrationQueue } from './integration-queue.js';
import {
  buildMeetingDelivery,
  MeetingDeliveryNotReadyError,
  parseMeetingDelivery,
  publishedMeetingDelivery,
  type FinalMeetingDecision,
  type MeetingDelivery,
} from './meeting-delivery.js';
import { prepareFrozenDeliveryCandidate } from './delivery-candidate.js';
import {
  CoordinatorReviewDriver,
  type CoordinatorReviewBriefing,
} from './coordinator-review-driver.js';
import {
  listUncoveredCoordinatorReviewChunkIds,
  safeCoordinatorReviewProjection,
  type CoordinatorReviewFinding,
  type CoordinatorReviewSession,
} from './coordinator-review.js';
import { authorizeMeetingCommand, type MeetingCommandResult } from './meeting-command.js';
import { TaskWorkspaceManager } from './task-workspace.js';
import { DiagnosticLogger } from './diagnostic-logger.js';
import { PORTABLE_MEETING_COMMAND_PROMPT } from './orchestrator-prompts.js';
import {
  assessWorkerRuntime,
  probeWorkerRuntimeVersion,
} from './backends/worker-runtime-contract.js';
import {
  backendRuntimeSchema,
  type BackendRuntime,
} from './backends/task-profile.js';
import type {
  MeetingPlan,
  MeetingPlanNode,
  OrchestratorEvent,
  OrchestratorSource,
  WorkerSpecialtyKind,
  WorkerStatusKind,
} from './orchestrator-types.js';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AuthorizedMeetingContextSource,
  ContextSelection,
} from './task-context.js';
import {
  backendEffectiveProfileSchema,
  type BackendEffectiveProfile,
  type ContextPackage,
  type TaskAuthorityGrant,
  type TaskExecutionProfile,
  type TaskMessage,
} from './task-collaboration.js';
import {
  compileTaskAuthority,
  hashTaskAuthorityRequest,
} from './task-authority.js';
import { taskBudgetSchema, type TaskBudget } from './task-budget.js';
import {
  assertRecoveryActionAllowed,
  assessTaskRecovery,
  type TaskRecoveryAction,
} from './task-recovery.js';

export const MAX_HOSTS = 3;

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
  recoveredPlanVersion?: number;
  recoveredReviewSessions?: CoordinatorReviewSession[];
  /** How long an active review may sit without Coordinator progress before the
   * stall budget is charged. Set to 0 to disable the watchdog in tests. */
  reviewStallTimeoutMs?: number;
  /** How long a Coordinator -> expert `ask_host` may sit without any talker
   *  reply from the target before the Coordinator is nudged to decide whether
   *  to keep waiting or proceed. Host-to-host asks have no request/response
   *  correlation otherwise. Set to 0 to disable the watchdog in tests. */
  hostAskTimeoutMs?: number;
  /** Optional workspace allocator override. Production uses the Meeting-owned
   * manager created below; tests with stub sessions may inject one to exercise
   * the real managed-worktree delivery path without spawning a backend CLI. */
  workspaceManager?: TaskWorkspaceManager;
}

export class Orchestrator implements OrchestratorBridge {
  /** All host groups in this meeting. Always has at least 'default'. */
  private hostGroups = new Map<string, HostGroup>();
  /**
   * Host that owns talker coordination (plan chat, review turns, user routing).
   * This can move via setCoordinator; execution stays on DEFAULT_HOST_ID.
   */
  private coordinatorHostId = DEFAULT_HOST_ID;
  /**
   * Single authoritative task graph and worker pool for the whole Meeting.
   * Always bound to the default HostGroup — setCoordinator does not migrate it.
   */
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
  private repositoryReady: Promise<void>;
  private taskMailbox: TaskMailbox;
  private taskProjection: TaskProjectionResult = { tasks: [], diagnostics: [] };
  private deliveryHarness: DeliveryHarness;
  private coordinatorReviewDriver: CoordinatorReviewDriver;
  private integrationQueue: IntegrationQueue;
  private deliveryVerifier: CommandDeliveryVerifier;
  private expectedUserBaseRevision: string;
  private finalMeetingDelivery: MeetingDelivery | null = null;
  private finalMeetingDecision: FinalMeetingDecision | null = null;
  private finalDeliveryBuild?: Promise<MeetingDelivery | null>;
  private workspaceManager: TaskWorkspaceManager;
  private customWorkspaceManager: boolean;
  private diagnostics: DiagnosticLogger;
  private resumeBackendSessions: Record<string, BackendSessionSnapshot>;
  private recoveredTasks: Array<Record<string, unknown>>;
  private recoveredPlanVersion: number;
  private saveMemoryCallsThisSession = 0;
  private autoOrchestration = false;
  private pendingPlan: PlanMeetingTask[] | null = null;
  private pendingPlanBrief: MeetingPlanBrief | null = null;
  /** True while the Coordinator host is mid-turn. A briefing queued during a live
   *  turn is only read by the *next* turn, so the turn already in flight must not
   *  be charged against the review stall budget. */
  private coordinatorTurnActive = false;
  /** Reviews whose briefing landed mid-turn; they skip exactly one turn boundary. */
  private reviewsAwaitingFirstTurn = new Set<string>();
  private reviewStallTimer: ReturnType<typeof setInterval> | null = null;
  private readonly reviewStallTimeoutMs: number;
  /** Coordinator -> expert asks still awaiting any talker reply. Keyed by the
   *  target host id (one outstanding ask per expert; a new ask replaces it and
   *  re-arms the timer). Cleared when the expert emits any talker message. */
  private pendingHostAsks = new Map<string, { question: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly hostAskTimeoutMs: number;
  /** Cross-host messages that arrived before the target Host talker was ready. */
  private pendingCrossHostMessages = new Map<string, Array<{ from: string; text: string }>>();
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
  private resolvedDecisionContext = new Map<string, { id: string; summary: string }>();

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
    this.recoveredPlanVersion = Number.isSafeInteger(opts.recoveredPlanVersion)
      && (opts.recoveredPlanVersion ?? 0) >= 0
      ? opts.recoveredPlanVersion!
      : 0;
    this.repository = new MeetingRepository(this.meetingId, opts.recoverySeq);
    this.taskMailbox = new TaskMailbox(this.repository);
    this.customWorkspaceManager = opts.workspaceManager !== undefined;
    this.workspaceManager = opts.workspaceManager
      ?? new TaskWorkspaceManager(this.meetingId, this.cwd);
    const baseline = this.workspaceManager.inspectBaseline();
    const deliveryVerifier = new CommandDeliveryVerifier();
    this.deliveryVerifier = deliveryVerifier;
    this.expectedUserBaseRevision = baseline.revision;
    this.integrationQueue = new IntegrationQueue({
      meetingId: this.meetingId,
      expectedUserBaseRevision: baseline.revision,
      integrator: new GitDeliveryIntegrator(
        this.cwd,
        this.meetingId,
        path.join(homedir(), '.ahastation', 'integration-worktrees'),
      ),
      verify: (view, candidate, workspace) => deliveryVerifier.verify({
        deliveryId: view.id,
        ...(view.spec.taskId ? { taskId: view.spec.taskId } : {}),
        attempt: candidate.attempt,
        meetingId: view.meetingId,
        goal: view.spec.objective,
        acceptanceCriteria: structuredClone(view.spec.acceptanceCriteria),
        workspace,
        sourceRevision: view.sourceRevision,
      }, candidate.report),
      append: async (type, payload) => {
        const record = payload as {
          taskId?: string;
          attempt?: number;
        };
        await this.repository.appendTaskEvent(type, {
          schemaVersion: 1,
          taskId: record.taskId ?? 'unknown-integration-task',
          ...(record.attempt ? { attempt: record.attempt } : {}),
          data: payload,
        });
      },
      flush: () => this.repository.flush(),
    });
    this.reviewStallTimeoutMs = opts.reviewStallTimeoutMs ?? 180_000;
    this.hostAskTimeoutMs = opts.hostAskTimeoutMs ?? 120_000;
    this.coordinatorReviewDriver = new CoordinatorReviewDriver({
      append: async (type, payload) => {
        const projection = (payload as {
          session?: { taskId?: string; deliveryId?: string; attempt?: number };
        }).session;
        await this.repository.appendTaskEvent(type, {
          schemaVersion: 1,
          taskId: projection?.taskId ?? projection?.deliveryId ?? 'unknown-delivery',
          ...(projection?.attempt ? { attempt: projection.attempt } : {}),
          data: payload,
        });
      },
      flush: () => this.repository.flush(),
      notifyCoordinator: (briefing) => this.notifyCoordinatorReview(briefing),
      onCompleted: async (session) => {
        await this.deliveryHarness.completeCoordinatorReview(session.deliveryId, session);
      },
      onReworkRequested: async (session) => {
        await this.meetingScheduler.requestCoordinatorRework(session.deliveryId, session);
      },
      onPaused: (session) => this.escalateStalledReview(session),
    });
    for (const session of opts.recoveredReviewSessions ?? []) {
      try {
        this.coordinatorReviewDriver.restore(session);
      } catch {
        // A malformed review projection is never made authoritative.
      }
    }
    this.deliveryHarness = new DeliveryHarness({
      executionMode: 'external',
      verifier: deliveryVerifier,
      reviewer: new DeterministicDeliveryReviewer(),
      candidatePreparer: {
        prepare: (order, report, verification) =>
          prepareFrozenDeliveryCandidate({ order, report, verification }),
      },
      reviewDriver: this.coordinatorReviewDriver,
      integrator: {
        integrate: (view, candidate) => this.integrationQueue.enqueue(view, candidate),
      },
    });
    this.diagnostics = new DiagnosticLogger(this.meetingId);
    this.repositoryReady = this.repository
      .append(opts.meetingId ? 'meeting-recovered' : 'meeting-created', { cwd: this.cwd })
      .then(() => undefined, () => undefined);
    this.sessionFactory = opts.sessionFactory ?? Orchestrator.defaultClaudeFactory;

    // Create the default HostGroup. Use the user's preferred backend if specified.
    const defaultBackend = opts.defaultBackendId ?? DEFAULT_BACKEND_ID;
    const defaultBackendAdapter = getBackendRegistry().get(defaultBackend);
    if (!defaultBackendAdapter) throw new Error(`backend '${defaultBackend}' is not registered`);
    if (!defaultBackendAdapter.capabilities.coordinate) {
      throw new Error(`backend '${defaultBackend}' cannot coordinate`);
    }
    this.createHostGroup(DEFAULT_HOST_ID, defaultBackend);
    if (this.recoveredTasks.length > 0) {
      this.meetingScheduler.restoreTasks(this.recoveredTasks);
    }

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
      const so = (opts.sessionOptions ?? {}) as Record<string, unknown>;
      let systemPrompt: string | undefined;
      if (typeof so.systemPrompt === 'string') {
        systemPrompt = so.systemPrompt;
      } else if (so.systemPrompt && typeof so.systemPrompt === 'object' && 'append' in so.systemPrompt) {
        systemPrompt = (so.systemPrompt as { append?: string }).append;
      }
      // MCP-less backends speak the meeting protocol through fenced
      // ```meeting-command frames in their reply text instead of native
      // tools; teach them the portable command vocabulary.
      if (backendId === 'codex' || backendId === 'pocket-vibe') {
        systemPrompt = `${systemPrompt ?? ''}${PORTABLE_MEETING_COMMAND_PROMPT}`;
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
      const parsedTaskProfile = backendEffectiveProfileSchema.safeParse(so.taskProfile);
      const taskProfile = parsedTaskProfile.success ? parsedTaskProfile.data : undefined;
      const {
        taskProfile: _taskProfile,
        resumeSessionId,
        ...backendExtra
      } = so;
      const requestedModel = taskProfile?.model
        ?? (typeof so.model === 'string' ? so.model : undefined);
      const model = taskProfile
        ? taskProfile.model
        : backendId === 'codex'
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
          taskProfile,
          env,
          mcpServers: so.mcpServers as Record<string, unknown> | undefined,
          skills: Array.isArray(so.skills) ? so.skills : undefined,
          autoApproveScope: opts.autoApproveScope,
          confirmDestructive: opts.confirmDestructive,
          hostId: actorHostId,
          meetingId: this.meetingId,
          resumeSessionId: purpose === 'host'
            ? this.resumeBackendSessions[actorHostId]?.sessionId
            : typeof resumeSessionId === 'string'
              ? resumeSessionId
              : undefined,
          executionRole: purpose,
          extra: {
            ...backendExtra,
            ...(backendId === 'codex' ? { codexTransport: 'app-server' } : {}),
            // Kimi: ACP mode only understands device-code OAuth — it ignores
            // API keys entirely. When an apiKey is configured, fall back to
            // the one-shot CLI mode (buildEnv injects MOONSHOT_API_KEY).
            ...(backendId === 'kimi' && !auth.apiKey ? { kimiTransport: 'acp' } : {}),
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
      workspaceManager: id === DEFAULT_HOST_ID && (
        this.sessionFactory === Orchestrator.defaultClaudeFactory
        || this.customWorkspaceManager
      )
        ? this.workspaceManager
        : undefined,
      meetingId: this.meetingId,
      deliveryHarness: this.deliveryHarness,
      deliveryArtifactRoot: this.repository.deliveryArtifactRoot(),
      flushEvents: () => this.repository.flush(),
      getIntegrationHead: () => this.integrationQueue.currentHead(),
      initialPlanVersion: id === DEFAULT_HOST_ID ? this.recoveredPlanVersion : 0,
      getAuthorizedTaskContextSource: (taskId, selection) =>
        this.getAuthorizedTaskContextSource(taskId, selection),
      persistContextPackage: (contextPackage) =>
        this.persistContextPackage(contextPackage),
      compileTaskProfile: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (requestedProfile) => this.compileTaskProfile(requestedProfile)
        : undefined,
      persistTaskProfile: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => this.persistTaskProfile(input)
        : undefined,
      taskProfileCompilerRequired: this.sessionFactory === Orchestrator.defaultClaudeFactory,
      compileTaskAuthority: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => compileTaskAuthority(
            input.taskId,
            input.attempt,
            input.planVersion,
            input.approvalDecisionId,
            input.workspaceRoot,
            input.authorityRequest,
            input.approvedAt,
          )
        : undefined,
      persistTaskAuthority: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => this.persistTaskAuthority(input)
        : undefined,
      normalizePermissionRequest: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (backendId, native) => {
            const backend = getBackendRegistry().get(backendId);
            return backend?.normalizePermissionRequest?.(native) ?? {
              ok: false as const,
              diagnostic: 'unsupported-native-tool' as const,
              requiresUser: true as const,
            };
          }
        : undefined,
      persistPermissionDecision: this.sessionFactory === Orchestrator.defaultClaudeFactory
        ? (input) => this.persistPermissionDecision(input)
        : undefined,
      taskAuthorityCompilerRequired: this.sessionFactory === Orchestrator.defaultClaudeFactory,
      taskMailbox: this.taskMailbox,
    });
    this.hostGroups.set(id, hg);
    if (id === DEFAULT_HOST_ID) {
      this.meetingScheduler = hg.getScheduler();
      this.meetingScheduler.setTalkerProvider(() => this.defaultHost().getHost());
    }

    // Subscribe to cross-host messages targeting this group. Queue while the
    // talker handshake is still in flight so early broadcasts are not dropped.
    this.crossHostBus.subscribe(id, (msg) => {
      this.deliverCrossHostMessage(id, msg.from, msg.text);
    });

    return hg;
  }

  private deliverCrossHostMessage(hostId: string, from: string, text: string): void {
    const hg = this.hostGroups.get(hostId);
    const host = hg?.getHost();
    if (host) {
      host.sendUserText(`[cross-host from ${from}] ${text}`, 'normal');
      return;
    }
    const queue = this.pendingCrossHostMessages.get(hostId) ?? [];
    queue.push({ from, text });
    // Bound memory if a host never becomes ready.
    if (queue.length > 100) queue.splice(0, queue.length - 100);
    this.pendingCrossHostMessages.set(hostId, queue);
  }

  private flushPendingCrossHostMessages(hostId: string): void {
    const pending = this.pendingCrossHostMessages.get(hostId);
    if (!pending || pending.length === 0) return;
    this.pendingCrossHostMessages.delete(hostId);
    const host = this.hostGroups.get(hostId)?.getHost();
    if (!host) return;
    for (const msg of pending) {
      host.sendUserText(`[cross-host from ${msg.from}] ${msg.text}`, 'normal');
    }
  }

  /** Add a new host group to this meeting. Returns the host group id.
   *  The host's talker session is started asynchronously — the renderer shows
   *  a "Connecting…" placeholder until the session-ready event arrives. */
  addHost(backendId: string, hostId?: string): { ok: true; hostId: string } | { ok: false; error: string } {
    if (this.closed) return { ok: false, error: 'orchestrator is closed' };
    if (this.hostGroups.size >= MAX_HOSTS) {
      return { ok: false, error: `host capacity reached (${MAX_HOSTS}/${MAX_HOSTS})` };
    }
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
        this.flushPendingCrossHostMessages(id);
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
    this.pendingCrossHostMessages.delete(hostId);
    this.clearHostAsk(hostId);
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

  /**
   * Talker-role handoff only. WorkerScheduler, workspaces, and Integration Queue
   * stay on the default HostGroup — this is not an execution failover.
   */
  setCoordinator(hostId: string): {
    ok: true;
    coordinatorHostId: string;
    executionHostId: typeof DEFAULT_HOST_ID;
    handoff: 'talker-role-only';
  } | { ok: false; error: string } {
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
    void this.repository.append('coordinator-changed', {
      previous,
      current: hostId,
      executionHostId: DEFAULT_HOST_ID,
      handoff: 'talker-role-only',
    });
    // Talker provider follows the new coordinator; scheduler identity does not move.
    this.meetingScheduler.setTalkerProvider(() => this.coordinatorTalkerHost().getHost());
    hg.getHost()?.sendUserText(
      `[coordinator handoff] You are now the meeting talker/coordinator. Previous: ${previous}. `
      + `Worker execution remains on host '${DEFAULT_HOST_ID}' — this handoff does not migrate the Scheduler. `
      + `Current worker state:\n${this.describeWorkers()}`,
      'high',
    );
    this.hostGroups.get(previous)?.getHost()?.sendUserText(
      `[coordinator handoff] You are now an Expert Talker. ${hostId} is the sole Coordinator talker. `
      + `Worker scheduling still runs on '${DEFAULT_HOST_ID}'. `
      + 'Do not schedule or speak for the meeting; answer only direct mentions or coordinator requests.',
      'high',
    );
    // The incoming Coordinator inherits any review the previous one abandoned.
    this.coordinatorTurnActive = false;
    this.resumeDisconnectedReviews();
    void this.meetingScheduler.redeliverPendingWorkerQuestions();
    return {
      ok: true,
      coordinatorHostId: hostId,
      executionHostId: DEFAULT_HOST_ID,
      handoff: 'talker-role-only',
    };
  }

  getCoordinatorHostId(): string {
    return this.coordinatorHostId;
  }

  sendHostMessage(fromHostId: string, toHostId: string, text: string): { ok: boolean; error?: string; truncated?: boolean } {
    if (!this.hostGroups.has(fromHostId)) return { ok: false, error: `source host '${fromHostId}' not found` };
    if (!this.hostGroups.has(toHostId)) return { ok: false, error: `target host '${toHostId}' not found` };
    if (text.length === 0) return { ok: false, error: 'message length is invalid' };
    // Truncate to fit the bus cap instead of rejecting. The auto-forwarded
    // expert response path builds `[expert response from X] <text.slice>` and
    // ignores the return value, so an over-length reply used to be silently
    // dropped and the Coordinator never saw it. A marker keeps the cut visible.
    const HOST_MESSAGE_MAX = 20_000;
    const TRUNCATE_MARKER = '…[truncated]';
    let payload = text;
    let truncated = false;
    if (text.length > HOST_MESSAGE_MAX) {
      payload = text.slice(0, HOST_MESSAGE_MAX - TRUNCATE_MARKER.length) + TRUNCATE_MARKER;
      truncated = true;
    }
    this.crossHostBus.publish({ from: fromHostId, to: toHostId, text: payload });
    void this.repository.append('host-message', {
      fromHostId,
      toHostId,
      chars: payload.length,
      truncated,
    });
    // A Coordinator -> expert ask has no reply correlation; arm a watchdog so a
    // silent expert doesn't leave the Coordinator blocking blind. Any talker
    // message from the target clears it (see onHostGroupEvent).
    if (fromHostId === this.coordinatorHostId && toHostId !== this.coordinatorHostId) {
      this.trackHostAsk(toHostId, payload);
    }
    return { ok: true, truncated };
  }

  /** Arm (or re-arm) the host-ask watchdog for one expert target. Only the
   *  latest ask per target is tracked; a new ask replaces the previous timer. */
  private trackHostAsk(targetHostId: string, payload: string): void {
    if (this.hostAskTimeoutMs <= 0) return;
    const existing = this.pendingHostAsks.get(targetHostId);
    if (existing) clearTimeout(existing.timer);
    const question = payload.length > 400 ? `${payload.slice(0, 398)}…` : payload;
    const timer = setTimeout(() => {
      this.pendingHostAsks.delete(targetHostId);
      if (this.closed) return;
      this.notifyHostAskStalled(targetHostId, question);
    }, this.hostAskTimeoutMs);
    timer.unref?.();
    this.pendingHostAsks.set(targetHostId, { question, timer });
  }

  /** Any talker message from the expert counts as a reply - disarm its timer. */
  private clearHostAsk(targetHostId: string): void {
    const entry = this.pendingHostAsks.get(targetHostId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingHostAsks.delete(targetHostId);
  }

  private clearAllHostAsks(): void {
    for (const entry of this.pendingHostAsks.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingHostAsks.clear();
  }

  private notifyHostAskStalled(targetHostId: string, question: string): void {
    this.meetingScheduler.briefCoordinator({
      kind: 'stalled',
      title: `Expert ${targetHostId} 长时间未回复`,
      summary: `你向 ${targetHostId} 提出的问题已超过 ${Math.round(this.hostAskTimeoutMs / 1000)} 秒未收到回复：${question}\n可以继续等待，或自行推进 / 换一个专家 / 让用户决定；不要无限期阻塞。`,
      blockers: ['host-ask-timeout'],
      recommendedAction: 'request-user-decision',
    });
  }

  async executeMeetingCommand(hostId: string, raw: unknown): Promise<MeetingCommandResult> {
    const actor = this.hostGroups.get(hostId);
    if (!actor) return { ok: false, code: 'forbidden', error: `host '${hostId}' not found` };
    const authorized = authorizeMeetingCommand(raw, {
      hostId,
      role: hostId === this.coordinatorHostId ? 'coordinator' : 'expert',
    }, {
      defaultBackendId: this.defaultHost().backendId,
      ...this.normalizePlanOptions(),
    });
    if (!authorized.ok) return authorized;
    const command = authorized.command;
    try {
      switch (command.kind) {
        case 'propose-plan': {
          const result = await this.proposePlan(command.tasks, {
            goal: command.goal,
            approach: command.approach,
            steps: command.steps,
            risks: command.risks,
            openQuestions: command.openQuestions,
          });
          return result.ok
            ? { ok: true, value: { tasks: command.tasks.length } }
            : { ok: false, code: 'execution-failed', error: result.error };
        }
        case 'revise-plan': {
          const addedTasks = command.operations.flatMap((operation) =>
            operation.kind === 'add-task' ? [operation.task] : [],
          );
          const backendError = await this.validateExecutionBackends(addedTasks);
          if (backendError) {
            return { ok: false, code: 'execution-failed', error: backendError };
          }
          const result = await this.meetingScheduler.revisePlan(
            command.expectedPlanVersion,
            command.operations,
          );
          if (result.ok) {
            await this.repository.append('plan-revised-by-coordinator', {
              reason: command.reason,
              expectedPlanVersion: command.expectedPlanVersion,
              planVersion: result.planVersion,
              operations: command.operations,
            });
            await this.repository.flush();
            await this.snapshotActiveMeeting();
          }
          return result.ok
            ? { ok: true, value: { planVersion: result.planVersion } }
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
          const result = await this.steerWorker(command.workerId, command.addendum);
          return result.ok ? { ok: true, value: result } : { ok: false, code: 'execution-failed', error: result.reason };
        }
        case 'send-task-message': {
          const message = await this.meetingScheduler.sendTaskMessage(command.taskId, command.message);
          return { ok: true, value: { messageId: message.id, status: message.status } };
        }
        case 'follow-up-task': {
          const message = await this.meetingScheduler.queueFollowUp(command.taskId, command.message);
          return { ok: true, value: { messageId: message.id, status: message.status } };
        }
        case 'steer-task': {
          const result = await this.meetingScheduler.steerTask(command.taskId, command.message);
          return result.ok
            ? { ok: true, value: result }
            : { ok: false, code: 'execution-failed', error: result.reason };
        }
        case 'interrupt-task': {
          const result = await this.meetingScheduler.interruptTask(command.taskId, command.reason);
          return result.ok
            ? { ok: true, value: { messageId: result.message.id } }
            : { ok: false, code: 'execution-failed', error: result.error };
        }
        case 'forward-task-message': {
          const message = await this.meetingScheduler.forwardTaskMessage(
            command.fromTaskId,
            command.toTaskId,
            command.messageId,
          );
          return { ok: true, value: { messageId: message.id, status: message.status } };
        }
        case 'request-decision': {
          const result = await this.createDecision({
            question: command.question,
            context: command.context,
            options: command.options,
            deadline: command.deadlineMs,
          });
          return { ok: true, value: result };
        }
        case 'save-memory': {
          const result = await this.saveMemory({
            category: command.category,
            content: command.content,
            tags: command.tags,
          });
          return result.ok
            ? { ok: true, value: result }
            : { ok: false, code: 'execution-failed', error: result.error ?? 'memory save failed' };
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
  /** HostGroup that currently owns the Coordinator talker (may differ from execution). */
  private coordinatorTalkerHost(): HostGroup {
    const hg = this.hostGroups.get(this.coordinatorHostId);
    if (!hg) throw new Error('coordinator host group missing — this is a bug');
    return hg;
  }

  /**
   * Historical name: returns the current Coordinator talker host, not necessarily
   * the default execution HostGroup. Prefer executionHost() / coordinatorTalkerHost().
   */
  private defaultHost(): HostGroup {
    return this.coordinatorTalkerHost();
  }

  /** HostGroup that owns WorkerScheduler / workspaces (always default). */
  private executionHost(): HostGroup {
    const hg = this.hostGroups.get(DEFAULT_HOST_ID);
    if (!hg) throw new Error('default execution host group missing — this is a bug');
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
      // Any talker message from an expert counts as a reply to an outstanding
      // ask_host; disarm the watchdog so the Coordinator isn't falsely told it
      // timed out.
      this.clearHostAsk(hostId);
      const text = extractText(e.event.message);
      if (text) {
        this.sendHostMessage(
          hostId,
          this.coordinatorHostId,
          `[expert response from ${hostId}] ${text}`,
        );
      }
    }
    if (
      hostId === this.coordinatorHostId
      && e.source === 'talker'
      && e.event.kind === 'message'
    ) {
      const messageType = (e.event.message as { type?: unknown } | undefined)?.type;
      if (messageType === 'result') {
        this.coordinatorTurnActive = false;
        void this.driveCoordinatorReviews();
      } else if (messageType === 'assistant' || messageType === 'user') {
        this.coordinatorTurnActive = true;
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
      this.flushPendingCrossHostMessages(hostId);
      this.safeEmit({ source: 'system', hostId, event: { kind: 'session-ready' } });
      if (hostId === this.coordinatorHostId) {
        this.resumeDisconnectedReviews();
        await this.meetingScheduler.redeliverPendingWorkerQuestions();
      }
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
    if (this.closed || this.repository.isWriteFaulted()) return;
    // Ensure hostId is always present; default to 'default' when absent.
    if (!e.hostId) e = { ...e, hostId: DEFAULT_HOST_ID };
    const append = this.repository.append(`event:${e.event.kind}`, e);
    const shouldSnapshot = (
      e.event.kind === 'plan-updated'
      || e.event.kind === 'worker-spawned'
      || e.event.kind === 'worker-ended'
      || e.event.kind === 'coordinator-failed'
      || e.event.kind === 'worker-event'
      || e.event.kind === 'delivery-status'
      || e.event.kind === 'worker-delivery'
      || e.event.kind === 'meeting-delivery-updated'
    );
    // Every renderer-visible orchestration event is emitted only after its
    // journal line is durable. If one write fails, MeetingRepository faults
    // permanently and later live notifications are suppressed.
    void append.then(() => {
      if (this.closed || this.repository.isWriteFaulted()) return;
      this.emit(e);
      if (shouldSnapshot) {
        void this.snapshotActiveMeeting().catch((error) => {
          console.error('[orchestrator] rebuildable Meeting snapshot write failed', {
            kind: e.event.kind,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      if (
        e.event.kind === 'delivery-status'
        && e.event.delivery.status === 'accepted'
      ) {
        void this.prepareFinalMeetingDelivery().catch((error) => {
          console.error('[orchestrator] final Meeting delivery preparation failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }).catch((error) => {
      console.error('[orchestrator] event journal write failed; Meeting is fail-stopped', {
        kind: e.event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async start(greeting?: string) {
    await this.repositoryReady;
    this.repository.assertWritable();
    const journal = await MeetingRepository.replay(this.meetingId);
    this.integrationQueue.restore(journal);
    const interruptedIntegration = await this.integrationQueue.detectInterruptedOperation();
    if (interruptedIntegration) {
      const integrationTaskId = this.integrationQueue.snapshot().activeTaskId;
      const recovered = this.recoveredTasks.find((task) => task.id === integrationTaskId);
      if (recovered) {
        recovered.status = 'integration-conflict';
        recovered.recovery = assessTaskRecovery(recovered);
        this.meetingScheduler.markRecoveredIntegrationConflict(String(integrationTaskId));
      }
    }
    this.restoreFinalMeetingDelivery(journal);
    await this.reconcileInterruptedFinalAcceptance(journal);
    this.taskMailbox.restore(journal);
    this.taskProjection = projectMeetingTasks(journal);
    await this.defaultHost().start(greeting);
    this.flushPendingCrossHostMessages(this.coordinatorHostId);
    // A worker may have asked a question while the Coordinator host was still
    // starting; those messages are durable but undelivered. Re-deliver now.
    await this.meetingScheduler.redeliverPendingWorkerQuestions();
    if (this.recoveredTasks.length > 0) {
      this.meetingScheduler.emitRecoveredState();
      await this.autoResumeRecoveredReadOnlyTasks();
    }
    if (this.finalMeetingDelivery || this.finalMeetingDecision) {
      this.safeEmit({
        source: 'system',
        event: {
          kind: 'meeting-delivery-updated',
          delivery: this.finalMeetingDelivery
            ? structuredClone(this.finalMeetingDelivery)
            : null,
          decision: this.finalMeetingDecision
            ? structuredClone(this.finalMeetingDecision)
            : null,
        },
      });
    }
    // Persist the native backend handle before the renderer is told the Host
    // is ready. A crash after readiness can then recover the exact thread.
    await this.snapshotActiveMeeting();
  }

  async resolveRecoveredTask(
    taskId: string,
    action: TaskRecoveryAction,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.resolveRecoveredTaskWithActor(taskId, action, 'user');
  }

  private async autoResumeRecoveredReadOnlyTasks(): Promise<void> {
    const candidates = this.recoveredTasks
      .filter((task) => assessTaskRecovery(task).autoResume)
      .map((task) => String(task.id ?? ''))
      .filter(Boolean);
    for (const taskId of candidates) {
      const result = await this.resolveRecoveredTaskWithActor(
        taskId,
        'continue-read-only',
        'system-auto-read-only',
      );
      if (!result.ok) {
        await this.repository.append('recovered-task-auto-resume-failed', {
          schemaVersion: 1,
          taskId,
          error: result.error.slice(0, 2_000),
        });
      }
    }
  }

  private async resolveRecoveredTaskWithActor(
    taskId: string,
    action: TaskRecoveryAction,
    actor: 'user' | 'system-auto-read-only',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const index = this.recoveredTasks.findIndex((task) => task.id === taskId);
    if (index < 0) return { ok: false, error: 'interrupted task not found' };
    const current = this.recoveredTasks[index];
    if (
      current.status !== 'interrupted'
      && current.status !== 'running'
      && current.status !== 'budget-paused'
      && current.status !== 'integration-conflict'
    ) {
      return { ok: false, error: `task is already ${String(current.status)}` };
    }
    let recovery;
    try {
      recovery = assertRecoveryActionAllowed(current, action);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (actor === 'system-auto-read-only' && !recovery.autoResume) {
      return { ok: false, error: 'only explicit read-only tasks may auto-resume' };
    }
    if (actor !== 'user' && action !== 'continue-read-only') {
      return { ok: false, error: 'side-effecting recovery requires a user decision' };
    }
    if (action === 'resolve-integration-conflict') {
      const resolution = await this.integrationQueue.resolveInterruptedOperation(taskId);
      if (!resolution.ok) return resolution;
      await this.repository.append('recovered-integration-conflict-resolved', {
        schemaVersion: 1,
        taskId,
        action,
        actor,
        recovery,
      });
      await this.repository.flush();
      this.recoveredTasks[index] = { ...current, status: 'interrupted' };
      this.meetingScheduler.clearRecoveredIntegrationConflict(taskId);
      await this.snapshotActiveMeeting();
      return { ok: true };
    }

    const recoveredTask: PlanMeetingTaskInput = {
      id: String(current.id ?? ''),
      title: String(current.title ?? current.id ?? 'Recovered task'),
      prompt: String(current.prompt ?? ''),
      deps: Array.isArray(current.deps) ? current.deps.map(String) : [],
      executorBackendId: typeof current.executorBackendId === 'string'
        ? current.executorBackendId
        : undefined,
      writePaths: Array.isArray(current.writePaths) ? current.writePaths.map(String) : undefined,
      executionProfile: current.executionProfile as PlanMeetingTaskInput['executionProfile'],
      contextSelection: current.contextSelection as PlanMeetingTaskInput['contextSelection'],
      workspaceMode: current.workspaceMode as PlanMeetingTaskInput['workspaceMode'],
      authorityRequest: current.authorityRequest as PlanMeetingTaskInput['authorityRequest'],
      budget: current.budget as PlanMeetingTaskInput['budget'],
      acceptanceCriteria: Array.isArray(current.acceptanceCriteria)
        ? current.acceptanceCriteria
        : undefined,
      requiresDecision: typeof current.requiresDecision === 'boolean'
        ? current.requiresDecision
        : undefined,
    };
    let task: PlanMeetingTask;
    try {
      task = normalizePlanMeetingTasks(
        [recoveredTask],
        this.defaultHost().backendId,
        this.normalizePlanOptions(),
      ).tasks[0];
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!task.id || !task.prompt) return { ok: false, error: 'recovered task is missing its id or prompt' };
    if (action !== 'abandon-task') {
      const backendError = await this.validateExecutionBackends([task]);
      if (backendError) return { ok: false, error: backendError };
    }
    // Persist and fsync the exact user/automatic authorization before any
    // Backend prompt can be sent by Scheduler.spawnReadyWorkers().
    await this.repository.append('recovered-task-resolution-authorized', {
      schemaVersion: 1,
      taskId,
      action,
      actor,
      recovery,
      attempt: typeof current.attempt === 'number' ? current.attempt : 1,
    });
    await this.repository.flush();
    const result = await this.meetingScheduler.resolveRecoveredTask(
      taskId,
      action as Exclude<TaskRecoveryAction, 'resolve-integration-conflict'>,
    );
    if (!result.ok) return result;
    if (action === 'abandon-task') {
      this.recoveredTasks[index] = { ...current, status: 'failed' };
    } else {
      this.recoveredTasks.splice(index, 1);
    }
    await this.repository.append('recovered-task-resolved', {
      schemaVersion: 1,
      taskId,
      action,
      actor,
    });
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
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'plan-updated',
        plan: { version: this.meetingScheduler.getPlanVersion(), nodes },
      },
    });
  }

  private snapshotActiveMeeting(): Promise<void> {
    const liveTasks = this.meetingScheduler.snapshot();
    return this.repository.snapshot({
      status: 'active',
      cwd: this.cwd,
      coordinatorHostId: this.coordinatorHostId,
      hosts: this.listHosts(),
      tasks: liveTasks.length > 0 ? liveTasks : this.recoveredTasks,
      taskMailboxes: (liveTasks.length > 0 ? liveTasks : this.recoveredTasks)
        .map((task) => {
          const taskId = String(task.id ?? '');
          const messages = taskId ? this.taskMailbox.list(taskId) : [];
          return {
            taskId,
            cursor: messages.at(-1)?.seq ?? 0,
            pending: messages
              .filter((message) => message.status !== 'acknowledged')
              .slice(-500)
              .map((message) => ({
                id: message.id,
                seq: message.seq,
                attempt: message.attempt,
                kind: message.kind,
                status: message.status,
              })),
          };
        })
        .filter((mailbox) => mailbox.taskId),
      reviewSessions: this.coordinatorReviewDriver.snapshot(),
      integrationQueue: this.integrationQueue.snapshot(),
      planVersion: this.meetingScheduler.getPlanVersion(),
      autoOrchestration: this.autoOrchestration,
      finalMeetingDelivery: this.finalMeetingDelivery
        ? structuredClone(this.finalMeetingDelivery)
        : null,
      finalMeetingDecision: this.finalMeetingDecision
        ? structuredClone(this.finalMeetingDecision)
        : null,
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

  resolvePermission(
    id: string,
    decision: 'allow' | 'deny',
    message?: string,
    scope: 'worker' | 'task-wide' = 'worker',
  ) {
    // Try every active host group; only the one that issued the permission
    // request actually has a matching pending entry.
    for (const hg of this.hostGroups.values()) {
      hg.resolvePermission(id, decision, message, scope);
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

  getDeliveryArtifactRoot(): string {
    return this.repository.deliveryArtifactRoot();
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
    this.stopReviewStallWatchdog();
    this.clearAllHostAsks();

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
  async installPlan(tasks: PlanMeetingTaskInput[]): Promise<{ ok: true } | { ok: false; error: string }> {
    let normalized: PlanMeetingTask[];
    try {
      normalized = normalizePlanMeetingTasks(
        tasks,
        this.defaultHost().backendId,
        this.normalizePlanOptions(),
      ).tasks;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    normalized = this.adaptPlanForWorkspaceBaseline(normalized);
    const backendError = await this.validateExecutionBackends(normalized);
    if (backendError) return { ok: false, error: backendError };
    return this.installApprovedPlan(normalized, 'manual-install');
  }

  /** Internal Task 9 seam; renderer and Backends never receive the repository
   * or mutate mailbox state directly. */
  getTaskMailbox(): TaskMailbox {
    return this.taskMailbox;
  }

  getTaskProjection(): TaskProjectionResult {
    return {
      tasks: structuredClone(this.taskProjection.tasks),
      diagnostics: structuredClone(this.taskProjection.diagnostics),
    };
  }

  /** Main-process Task IPC source. It intentionally returns internal records
   * only to the privileged IPC projector; the renderer receives a redacted
   * task view from electron/ipc/tasks.ts. */
  async getTaskInspectorSource(taskId: string): Promise<{
    meetingId: string;
    task: ReturnType<WorkerScheduler['snapshot']>[number];
    record: TaskProjectionResult['tasks'][number] | null;
    diagnostics: TaskProjectionResult['diagnostics'];
    mailbox: TaskMessage[];
    events: PersistedMeetingEvent[];
  } | null> {
    await this.repositoryReady;
    const task = this.meetingScheduler.snapshot().find((entry) => entry.id === taskId);
    if (!task) return null;
    const events = await this.repository.replayAll();
    const durableProjection = projectMeetingTasks(events);
    return {
      meetingId: this.meetingId,
      task: structuredClone(task),
      record: structuredClone(
        durableProjection.tasks.find((entry) => entry.id === taskId) ?? null,
      ),
      diagnostics: structuredClone(
        durableProjection.diagnostics.filter(
          (entry) => entry.taskId === undefined || entry.taskId === taskId,
        ),
      ),
      mailbox: this.taskMailbox.list(taskId),
      events,
    };
  }

  async replayMeetingJournal(): Promise<PersistedMeetingEvent[]> {
    await this.repositoryReady;
    return this.repository.replayAll();
  }

  subscribeMeetingJournal(
    listener: (event: PersistedMeetingEvent) => void,
  ): () => void {
    return this.repository.subscribe(listener);
  }

  private normalizePlanOptions(): {
    cwd: string;
    baselineKind: 'git-clean' | 'git-dirty' | 'non-git';
  } {
    return {
      cwd: this.cwd,
      baselineKind: this.workspaceManager.inspectBaseline().kind,
    };
  }

  async proposePlan(
    tasks: PlanMeetingTaskInput[],
    briefInput?: MeetingPlanBriefInput,
  ): Promise<{ ok: true; appliedDefaults?: AppliedTaskDefaults[] } | { ok: false; error: string }> {
    let normalized: PlanMeetingTask[];
    let appliedDefaults: AppliedTaskDefaults[];
    try {
      const result = normalizePlanMeetingTasks(
        tasks,
        this.defaultHost().backendId,
        this.normalizePlanOptions(),
      );
      normalized = result.tasks;
      appliedDefaults = result.appliedDefaults;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    normalized = this.adaptPlanForWorkspaceBaseline(normalized);
    const backendError = await this.validateExecutionBackends(normalized);
    if (backendError) return { ok: false, error: backendError };
    const brief = normalizeMeetingPlanBrief(briefInput, normalized);
    const applied = appliedDefaults.length > 0 ? { appliedDefaults } : {};
    if (!this.autoOrchestration) {
      this.pendingPlan = normalized.map((task) => ({ ...task, deps: [...(task.deps ?? [])] }));
      this.pendingPlanBrief = brief;
      this.safeEmit({
        source: 'system',
        event: { kind: 'plan-proposed', tasks: this.pendingPlan, brief },
      });
      void this.repository.append('plan-proposed', { tasks: this.pendingPlan, brief });
      return { ok: true, ...applied };
    }
    const installed = await this.installApprovedPlan(normalized, 'auto-orchestration');
    return installed.ok ? { ok: true, ...applied } : installed;
  }

  private adaptPlanForWorkspaceBaseline(tasks: PlanMeetingTask[]): PlanMeetingTask[] {
    const kind = this.workspaceManager.inspectBaseline().kind;
    if (kind === 'git-clean') return tasks;
    return tasks.map((task) => {
      const workspaceMode = coerceWorkspaceModeForBaseline(task.workspaceMode, kind);
      return workspaceMode === task.workspaceMode ? task : { ...task, workspaceMode };
    });
  }

  setAutoOrchestration(enabled: boolean): void {
    this.autoOrchestration = enabled;
    void this.repository.append('orchestration-mode-changed', { enabled });
  }

  async approvePendingPlan(
    approved: boolean,
    revisedTasks?: PlanMeetingTaskInput[],
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let tasks: PlanMeetingTask[] | null = this.pendingPlan;
    if (revisedTasks) {
      try {
        tasks = normalizePlanMeetingTasks(
          revisedTasks,
          this.defaultHost().backendId,
          this.normalizePlanOptions(),
        ).tasks;
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      tasks = this.adaptPlanForWorkspaceBaseline(tasks);
      const backendError = await this.validateExecutionBackends(tasks);
      if (backendError) return { ok: false, error: backendError };
    }
    this.pendingPlan = null;
    this.pendingPlanBrief = null;
    if (!tasks) return { ok: false, error: 'no pending plan' };
    if (!approved) return { ok: true };
    return this.installApprovedPlan(tasks, 'plan-meeting-confirmation');
  }

  private async installApprovedPlan(
    tasks: PlanMeetingTask[],
    source: 'manual-install' | 'auto-orchestration' | 'plan-meeting-confirmation',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const decisionId = randomUUID();
    const approvedAt = Date.now();
    await this.repository.append('plan-authority-approved', {
      decisionId,
      approvedAt,
      source,
      planVersion: this.meetingScheduler.getPlanVersion() + 1,
      tasks: tasks.map((task) => ({
        taskId: task.id,
        authorityRequestHash: hashTaskAuthorityRequest(task.authorityRequest),
      })),
    });
    await this.repository.flush();
    return this.meetingScheduler.installPlan(tasks, { decisionId, approvedAt });
  }

  private async validateExecutionBackends(tasks: PlanMeetingTask[]): Promise<string | null> {
    const defaultBackendId = this.defaultHost().backendId;
    const checked = new Set<string>();
    for (const task of tasks) {
      const backendId = task.executorBackendId ?? defaultBackendId;
      const backend = getBackendRegistry().get(backendId);
      if (!backend) return `backend '${backendId}' is not registered`;
      if (!backend.capabilities.executeTasks) {
        return `backend '${backendId}' cannot execute delivery tasks`;
      }
      if (!backend.compileTaskProfile) {
        return `backend '${backendId}' does not compile task profiles`;
      }
      if (!backend.normalizePermissionRequest) {
        return `backend '${backendId}' does not normalize permission requests`;
      }
      if (checked.has(backendId)) continue;
      checked.add(backendId);
      // Unit/integration tests inject a controlled SessionFactory. Production
      // plans must additionally pass the exact runtime/auth gate before any
      // task is installed into the global Scheduler.
      if (this.sessionFactory !== Orchestrator.defaultClaudeFactory) continue;
      const authEntry = getBackendAuth(backendId);
      const auth = authEntry
        ? {
            authMode: authEntry.authMode,
            apiKey: authEntry.apiKey,
            baseUrl: authEntry.baseUrl,
            model: authEntry.model,
          }
        : { authMode: 'none' as const };
      const probe = await getBackendRegistry().probe(backendId, auth);
      const assessment = assessWorkerRuntime({
        backendId,
        installed: probe.installed,
        implementationEnabled: backend.capabilities.executeTasks,
        authenticated: probe.auth !== 'required',
        version: probeWorkerRuntimeVersion(backendId, probe.runtimePath),
      });
      if (assessment.state !== 'available') {
        return `backend '${backendId}' is unavailable: ${assessment.reason}`;
      }
    }
    return null;
  }

  // ===========================================================================
  // OrchestratorBridge — methods called from the MCP tool factories in
  // meeting-mcp.ts. These route to the default host's scheduler. In a full
  // multi-host setup, the bridge would be hostId-aware; for now the default
  // host handles all MCP tool callbacks.

  async delegateSingleTask(input: string | {
    description: string;
    writePaths?: string[];
    workspaceMode?: PlanMeetingTaskInput['workspaceMode'];
    commands?: string[][];
    networkHosts?: string[];
    toolKinds?: string[];
  }): Promise<
    | {
        ok: true;
        workerId: string;
        specialty: WorkerSpecialtyKind;
        reused: boolean;
        status: 'spawned' | 'proposed' | 'installed';
        appliedDefaults?: string[];
      }
    | { ok: false; error: string }
  > {
    const request = typeof input === 'string' ? { description: input } : input;
    const description = request.description.trim();
    if (!description) return { ok: false, error: 'description is required' };

    const backendId = this.defaultHost().backendId;
    const backend = getBackendRegistry().get(backendId);
    if (!backend) return { ok: false, error: `backend '${backendId}' is not registered` };
    if (!backend.capabilities.executeTasks) {
      return { ok: false, error: `backend '${backendId}' cannot execute delivery tasks` };
    }

    const title = titleFromDescription(description);
    const specialty = inferSpecialty(`${title} ${description}`);

    // Production Claude meetings require an approved authority grant. Route the
    // single-task shorthand through proposePlan so it gets the same envelope
    // and user-approval path as plan_meeting — bare registerHandle would throw
    // in ensureTaskAuthority and leave the Talker thinking the task spawned.
    if (this.sessionFactory === Orchestrator.defaultClaudeFactory) {
      const writePaths = request.writePaths ?? [];
      const workerId = `delegate-${randomUUID().slice(0, 8)}`;
      // Intent defaults (sandbox write path / test commands / workspace mode)
      // are applied inside normalizePlanMeetingTask via proposePlan.
      const task: PlanMeetingTaskInput = {
        id: workerId,
        title,
        prompt: description,
        deps: [],
        ...(writePaths.length > 0 ? { writePaths } : {}),
        ...(request.workspaceMode ? { workspaceMode: request.workspaceMode } : {}),
        ...(request.commands || request.networkHosts || request.toolKinds
          ? {
              authorityRequest: {
                writePaths,
                toolKinds: request.toolKinds
                  ?? (writePaths.length > 0 ? ['read', 'write'] : ['read']),
                workingDirectories: ['.'],
                commands: request.commands ?? [],
                environmentKeys: [],
                maxCommandTimeoutMs: 1_800_000,
                networkHosts: request.networkHosts ?? [],
              },
            }
          : {}),
      };
      const proposed = await this.proposePlan([task]);
      if (!proposed.ok) return proposed;
      const notes = proposed.appliedDefaults?.find((entry) => entry.taskId === workerId)?.notes;
      return {
        ok: true,
        workerId,
        specialty,
        reused: false,
        status: this.autoOrchestration ? 'installed' : 'proposed',
        ...(notes?.length ? { appliedDefaults: notes } : {}),
      };
    }

    const delegated = this.meetingScheduler.delegateSingleTask(description);
    return { ok: true, ...delegated, status: 'spawned' };
  }

  steerWorker(workerId: string, addendum: string): Promise<SteerResult> {
    // Search across all host groups — worker IDs are unique.
    return this.meetingScheduler.steerWorker(workerId, addendum);
  }

  async sendTaskMessage(taskId: string, message: string): Promise<{ id: string; status: string }> {
    const queued = await this.meetingScheduler.sendTaskMessage(taskId, message);
    return { id: queued.id, status: queued.status };
  }

  async queueTaskFollowUp(taskId: string, message: string): Promise<{ id: string; status: string }> {
    const queued = await this.meetingScheduler.queueFollowUp(taskId, message);
    return { id: queued.id, status: queued.status };
  }

  async extendTaskBudget(
    taskId: string,
    expectedPlanVersion: number,
    rawBudget: TaskBudget,
  ): Promise<{ planVersion: number; budget: TaskBudget }> {
    const budget = taskBudgetSchema.parse(rawBudget);
    if (expectedPlanVersion !== this.meetingScheduler.getPlanVersion()) {
      throw new Error(
        `stale plan version: expected ${expectedPlanVersion}, current ${this.meetingScheduler.getPlanVersion()}`,
      );
    }
    const task = this.meetingScheduler.snapshot().find((entry) => entry.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (task.status !== 'budget-paused' || !task.budget) {
      throw new Error(`task ${taskId} is not paused by its budget`);
    }
    const keys = [
      'maxAttempts',
      'maxTotalTokens',
      'maxTotalDurationMs',
      'maxStagnantAttempts',
    ] as const;
    if (keys.some((key) => budget[key] < task.budget![key])) {
      throw new Error('a budget extension cannot reduce an approved limit');
    }
    if (keys.every((key) => budget[key] === task.budget![key])) {
      throw new Error('a budget extension must increase at least one limit');
    }
    const decisionId = `budget-${randomUUID()}`;
    await this.repository.appendTaskEvent('task-budget-extension-approved', {
      schemaVersion: 1,
      taskId,
      attempt: task.attempt,
      data: {
        schemaVersion: 1,
        decisionId,
        expectedPlanVersion,
        previousBudget: structuredClone(task.budget),
        budget: structuredClone(budget),
        authorityRequestHash: task.authorityRequest
          ? hashTaskAuthorityRequest(task.authorityRequest)
          : null,
        decidedAt: Date.now(),
      },
    });
    await this.repository.flush();
    const result = await this.meetingScheduler.extendTaskBudget(
      taskId,
      expectedPlanVersion,
      budget,
      decisionId,
    );
    await this.repository.appendTaskEvent('task-budget-extension-applied', {
      schemaVersion: 1,
      taskId,
      attempt: (task.attempt ?? 1) + 1,
      data: {
        schemaVersion: 1,
        decisionId,
        planVersion: result.planVersion,
        budget: structuredClone(result.budget),
      },
    });
    await this.snapshotActiveMeeting();
    await this.repository.flush();
    return result;
  }

  interruptWorker(workerId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.meetingScheduler.interruptWorker(workerId, reason);
  }

  async forwardTaskMessage(
    fromTaskId: string,
    toTaskId: string,
    messageId: string,
  ): Promise<{ id: string; status: string }> {
    const forwarded = await this.meetingScheduler.forwardTaskMessage(
      fromTaskId,
      toTaskId,
      messageId,
    );
    return { id: forwarded.id, status: forwarded.status };
  }

  async askCoordinator(
    workerId: string,
    question: string,
    sourceAttempt?: number,
  ): Promise<{ id: string; status: string }> {
    const message = await this.meetingScheduler.recordWorkerQuestion(
      workerId,
      question,
      sourceAttempt,
    );
    return { id: message.id, status: message.status };
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

  private async getAuthorizedTaskContextSource(
    taskId: string,
    selection: ContextSelection,
  ): Promise<AuthorizedMeetingContextSource> {
    const messages = Array.from(this.hostGroups.values())
      .flatMap((host) => host.getTranscript())
      .sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
    const meetingSummary = messages
      .slice(-40)
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
      .join('\n');
    return {
      messages,
      meetingSummary,
      decisions: Array.from(this.resolvedDecisionContext.values())
        .sort((left, right) => left.id.localeCompare(right.id)),
      dependencyReports: this.meetingScheduler.getAcceptedDependencyReports(taskId),
      attachments: await listAuthorizedAssetReferences(this.cwd, selection.attachmentIds),
    };
  }

  private async persistContextPackage(contextPackage: ContextPackage): Promise<void> {
    await this.repository.appendTaskEvent('context-package-frozen', {
      schemaVersion: 1,
      taskId: contextPackage.taskId,
      attempt: contextPackage.attempt,
      data: { package: contextPackage },
    });
    await this.repository.flush();
  }

  private async compileTaskProfile(
    requestedProfile: TaskExecutionProfile,
  ): Promise<{
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }> {
    const registry = getBackendRegistry();
    const backend = registry.get(requestedProfile.backendId);
    if (!backend) {
      throw new Error(`backend '${requestedProfile.backendId}' is not registered`);
    }
    if (!backend.capabilities.executeTasks || !backend.compileTaskProfile) {
      throw new Error(`backend '${requestedProfile.backendId}' cannot compile Worker task profiles`);
    }
    const runtimePath = backend.resolveBinary();
    if (!runtimePath) {
      throw new Error(`backend '${requestedProfile.backendId}' runtime is unavailable`);
    }
    const version = probeWorkerRuntimeVersion(requestedProfile.backendId, runtimePath);
    const assessment = assessWorkerRuntime({
      backendId: requestedProfile.backendId,
      installed: true,
      implementationEnabled: true,
      authenticated: true,
      version,
    });
    if (assessment.state !== 'available' || !assessment.version) {
      throw new Error(
        `backend '${requestedProfile.backendId}' runtime profile is unavailable: ${assessment.reason}`,
      );
    }
    const runtime = backendRuntimeSchema.parse({
      schemaVersion: 1,
      backendId: requestedProfile.backendId,
      runtimeVersion: assessment.version,
    });
    return {
      runtime,
      effectiveProfile: registry.compileTaskProfile(
        requestedProfile.backendId,
        requestedProfile,
        runtime,
      ),
    };
  }

  private async persistTaskProfile(input: {
    taskId: string;
    attempt: number;
    requestedProfile: TaskExecutionProfile;
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }): Promise<void> {
    await this.repository.appendTaskEvent('backend-profile-compiled', {
      schemaVersion: 1,
      taskId: input.taskId,
      attempt: input.attempt,
      data: {
        requestedProfile: input.requestedProfile,
        runtime: input.runtime,
        effectiveProfile: input.effectiveProfile,
        capabilityHash: input.effectiveProfile.capabilityHash,
      },
    });
    await this.repository.flush();
  }

  private async persistTaskAuthority(input: {
    taskId: string;
    attempt: number;
    authorityGrant: TaskAuthorityGrant;
  }): Promise<void> {
    await this.repository.appendTaskEvent('task-authority-compiled', {
      schemaVersion: 1,
      taskId: input.taskId,
      attempt: input.attempt,
      data: {
        authorityGrant: input.authorityGrant,
        grantHash: input.authorityGrant.grantHash,
      },
    });
    await this.repository.flush();
  }

  private async persistPermissionDecision(input: {
    taskId: string;
    attempt: number;
    nativeRequestId: string;
    decision: 'allow' | 'ask-user' | 'deny';
    reason: string;
    safeInput: Record<string, unknown>;
    grantHash?: string;
  }): Promise<void> {
    await this.repository.appendTaskEvent('task-permission-decided', {
      schemaVersion: 1,
      taskId: input.taskId,
      attempt: input.attempt,
      data: {
        nativeRequestId: input.nativeRequestId,
        decision: input.decision,
        reason: input.reason,
        safeInput: input.safeInput,
        ...(input.grantHash ? { grantHash: input.grantHash } : {}),
      },
    });
    await this.repository.flush();
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

  markWorkerTaskDone(workerId: string, summary: string, sourceAttempt?: number): void {
    // Search across all host groups.
    this.meetingScheduler.markTaskDone(workerId, summary, sourceAttempt);
  }

  /** Build and durably expose the sole final Meeting delivery. Per-task
   * acceptance only advances the private integration branch; this method
   * additionally re-verifies every accepted task on the exact final head. */
  async prepareFinalMeetingDelivery(): Promise<MeetingDelivery | null> {
    if (this.finalDeliveryBuild) return this.finalDeliveryBuild;
    this.finalDeliveryBuild = this.buildFinalMeetingDelivery().finally(() => {
      this.finalDeliveryBuild = undefined;
    });
    return this.finalDeliveryBuild;
  }

  getMeetingDelivery(): Promise<MeetingDelivery | null> {
    return this.prepareFinalMeetingDelivery();
  }

  getFinalMeetingDecision(): FinalMeetingDecision | null {
    return this.finalMeetingDecision
      ? structuredClone(this.finalMeetingDecision)
      : null;
  }

  async acceptMeetingDelivery(
    deliveryId: string,
    contentHash: string,
  ): Promise<MeetingDelivery> {
    const delivery = await this.requireCurrentMeetingDelivery(deliveryId, contentHash);
    if (this.finalMeetingDecision) {
      if (
        this.finalMeetingDecision.kind === 'accept'
        && this.finalMeetingDecision.deliveryId === deliveryId
        && this.finalMeetingDecision.contentHash === contentHash
      ) return structuredClone(this.finalMeetingDelivery ?? delivery);
      throw new Error('final Meeting delivery already has a conflicting decision');
    }
    const intent = {
      schemaVersion: 1,
      deliveryId,
      contentHash,
      integrationHead: delivery.integrationHead,
      decidedAt: Date.now(),
    };
    await this.repository.append('meeting-delivery-accept-intent', intent);
    await this.repository.flush();
    const publication = await this.integrationQueue.publishFinalDelivery({
      deliveryId,
      contentHash,
      integrationHead: delivery.integrationHead,
      expectedUserBaseRevision: delivery.expectedUserBaseRevision,
    });
    const published = publishedMeetingDelivery(delivery);
    const decision: FinalMeetingDecision = {
      kind: 'accept',
      deliveryId,
      contentHash,
      integrationHead: publication.publishedHead,
      decidedAt: intent.decidedAt,
    };
    await this.repository.append('meeting-delivery-accepted', {
      schemaVersion: 1,
      delivery: published,
      decision,
      publication,
    });
    await this.repository.flush();
    this.finalMeetingDelivery = published;
    this.finalMeetingDecision = decision;
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'meeting-delivery-updated',
        delivery: structuredClone(published),
        decision: structuredClone(decision),
      },
    });
    await this.snapshotActiveMeeting();
    await this.integrationQueue.cleanupPublishedIntegration(publication.publishedHead);
    return structuredClone(published);
  }

  async requestMeetingDeliveryRework(
    deliveryId: string,
    contentHash: string,
    reason: string,
  ): Promise<{ planVersion: number; taskIds: string[] }> {
    const delivery = await this.requireCurrentMeetingDelivery(deliveryId, contentHash);
    const normalizedReason = reason.trim();
    if (!normalizedReason || normalizedReason.length > 20_000) {
      throw new Error('final Meeting rework reason must contain 1-20000 characters');
    }
    if (this.finalMeetingDecision) {
      if (
        this.finalMeetingDecision.kind === 'rework'
        && this.finalMeetingDecision.deliveryId === deliveryId
        && this.finalMeetingDecision.contentHash === contentHash
        && this.finalMeetingDecision.reason === normalizedReason
      ) {
        return {
          planVersion: this.finalMeetingDecision.planVersion,
          taskIds: [...this.finalMeetingDecision.taskIds],
        };
      }
      throw new Error('final Meeting delivery already has a conflicting decision');
    }
    await this.repository.append('meeting-delivery-rework-intent', {
      schemaVersion: 1,
      deliveryId,
      contentHash,
      integrationHead: delivery.integrationHead,
      reason: normalizedReason,
    });
    await this.repository.flush();
    const replacement = this.meetingScheduler.createFinalDeliveryRework(
      normalizedReason,
      contentHash,
    );
    const decision: FinalMeetingDecision = {
      kind: 'rework',
      deliveryId,
      contentHash,
      reason: normalizedReason,
      planVersion: replacement.planVersion,
      taskIds: [...replacement.taskIds],
      decidedAt: Date.now(),
    };
    await this.repository.append('meeting-delivery-rework-created', {
      schemaVersion: 1,
      decision,
      operations: replacement.taskIds.map((taskId, index) => ({
        kind: 'add-rework-task',
        taskId,
        supersedesTaskId: delivery.tasks[index]?.taskId,
        deliveryHash: contentHash,
        reason: normalizedReason,
      })),
    });
    await this.repository.flush();
    this.finalMeetingDecision = decision;
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'meeting-delivery-updated',
        delivery: structuredClone(delivery),
        decision: structuredClone(decision),
      },
    });
    await this.snapshotActiveMeeting();
    return replacement;
  }

  private async buildFinalMeetingDelivery(): Promise<MeetingDelivery | null> {
    const tasks = this.meetingScheduler.snapshot();
    const integration = await this.integrationQueue.inspectState();
    if (
      this.finalMeetingDelivery
      && this.finalMeetingDelivery.planVersion === this.meetingScheduler.getPlanVersion()
      && this.finalMeetingDelivery.integrationHead === integration.durableHead
    ) return structuredClone(this.finalMeetingDelivery);

    const meetingChecks: Array<{ taskId: string; summary: string }> = [];
    try {
      for (const task of tasks) {
        if (task.status !== 'accepted') continue;
        const delivery = task.delivery;
        const candidate = delivery?.candidate;
        if (!delivery || !candidate) {
          throw new MeetingDeliveryNotReadyError([`${task.id}:missing accepted candidate`]);
        }
        const verification = await this.deliveryVerifier.verify({
          deliveryId: delivery.id,
          taskId: task.id,
          attempt: candidate.attempt,
          meetingId: this.meetingId,
          goal: delivery.spec.objective,
          acceptanceCriteria: structuredClone(delivery.spec.acceptanceCriteria),
          workspace: integration.workspace,
          sourceRevision: integration.durableHead,
        }, candidate.report);
        if (!verification.passed) {
          throw new MeetingDeliveryNotReadyError([
            `${task.id}:${verification.error ?? 'full Meeting verification failed'}`,
          ]);
        }
        const summaries = verification.checks.map((check) => {
          if (typeof check === 'string') return check;
          if (check && typeof check === 'object') {
            const record = check as Record<string, unknown>;
            return String(record.summary ?? record.description ?? record.status ?? 'passed');
          }
          return String(check);
        });
        meetingChecks.push({
          taskId: task.id,
          summary: summaries.join('; ') || 'verification passed on final integration head',
        });
      }
      const delivery = buildMeetingDelivery({
        meetingId: this.meetingId,
        planVersion: this.meetingScheduler.getPlanVersion(),
        tasks,
        integrationHead: integration.durableHead,
        expectedUserBaseRevision: this.expectedUserBaseRevision,
        meetingVerification: {
          integrationHead: integration.durableHead,
          checks: meetingChecks,
        },
      });
      await this.repository.append('meeting-delivery-ready', {
        schemaVersion: 1,
        delivery,
      });
      await this.repository.flush();
      this.finalMeetingDelivery = delivery;
      this.finalMeetingDecision = null;
      this.safeEmit({
        source: 'system',
        event: {
          kind: 'meeting-delivery-updated',
          delivery: structuredClone(delivery),
          decision: null,
        },
      });
      await this.snapshotActiveMeeting();
      return structuredClone(delivery);
    } catch (error) {
      if (error instanceof MeetingDeliveryNotReadyError) return null;
      throw error;
    }
  }

  private async requireCurrentMeetingDelivery(
    deliveryId: string,
    contentHash: string,
  ): Promise<MeetingDelivery> {
    if (
      !deliveryId
      || !/^[0-9a-f]{64}$/u.test(contentHash)
    ) throw new Error('final Meeting delivery identity is invalid');
    const delivery = await this.prepareFinalMeetingDelivery();
    if (
      !delivery
      || delivery.id !== deliveryId
      || delivery.contentHash !== contentHash
    ) throw new Error('final Meeting delivery is stale or no longer ready');
    return delivery;
  }

  private restoreFinalMeetingDelivery(events: PersistedMeetingEvent[]): void {
    this.finalMeetingDelivery = null;
    this.finalMeetingDecision = null;
    for (const event of events) {
      if (event.type === 'meeting-delivery-ready') {
        const record = objectRecord(event.payload);
        const delivery = parseMeetingDelivery(record.delivery);
        if (delivery) {
          this.finalMeetingDelivery = delivery;
          this.finalMeetingDecision = null;
        }
        continue;
      }
      if (event.type === 'meeting-delivery-accepted') {
        const record = objectRecord(event.payload);
        const delivery = parseMeetingDelivery(record.delivery);
        const decision = parseFinalMeetingDecision(record.decision);
        if (delivery && decision?.kind === 'accept') {
          this.finalMeetingDelivery = delivery;
          this.finalMeetingDecision = decision;
        }
        continue;
      }
      if (event.type === 'meeting-delivery-rework-created') {
        const decision = parseFinalMeetingDecision(objectRecord(event.payload).decision);
        if (decision?.kind === 'rework') this.finalMeetingDecision = decision;
      }
    }
  }

  private async reconcileInterruptedFinalAcceptance(
    events: PersistedMeetingEvent[],
  ): Promise<void> {
    if (!this.finalMeetingDelivery || this.finalMeetingDecision) return;
    const intentEvent = [...events].reverse().find(
      (event) => event.type === 'meeting-delivery-accept-intent',
    );
    if (!intentEvent || !intentEvent.payload || typeof intentEvent.payload !== 'object') return;
    const intent = intentEvent.payload as Record<string, unknown>;
    const queue = this.integrationQueue.snapshot();
    const request = queue.publicationRequest;
    const publication = queue.publication;
    const delivery = this.finalMeetingDelivery;
    if (
      queue.publicationState !== 'published'
      || !request
      || !publication
      || intent.deliveryId !== delivery.id
      || intent.contentHash !== delivery.contentHash
      || intent.integrationHead !== delivery.integrationHead
      || request.deliveryId !== delivery.id
      || request.contentHash !== delivery.contentHash
      || request.integrationHead !== delivery.integrationHead
      || request.expectedUserBaseRevision !== delivery.expectedUserBaseRevision
      || publication.expectedUserBaseRevision !== delivery.expectedUserBaseRevision
      || publication.integrationHead !== delivery.integrationHead
      || publication.publishedHead !== delivery.integrationHead
    ) return;
    const decidedAt = typeof intent.decidedAt === 'number' && Number.isFinite(intent.decidedAt)
      ? intent.decidedAt
      : intentEvent.ts;
    const published = publishedMeetingDelivery(delivery);
    const decision: FinalMeetingDecision = {
      kind: 'accept',
      deliveryId: delivery.id,
      contentHash: delivery.contentHash,
      integrationHead: publication.publishedHead,
      decidedAt,
    };
    await this.repository.append('meeting-delivery-accepted', {
      schemaVersion: 1,
      delivery: published,
      decision,
      publication,
      recoveredFromAcceptIntentSeq: intentEvent.seq,
    });
    await this.repository.flush();
    this.finalMeetingDelivery = published;
    this.finalMeetingDecision = decision;
    await this.snapshotActiveMeeting();
    await this.integrationQueue.cleanupPublishedIntegration(publication.publishedHead);
  }

  async acceptDelivery(deliveryId: string, candidateId: string) {
    const view = await this.meetingScheduler.acceptDelivery(deliveryId, candidateId);
    await this.repository.append('delivery-user-accepted', {
      deliveryId,
      candidateId,
      attempt: view.attempt,
    });
    await this.snapshotActiveMeeting();
    await this.repository.flush();
    return view;
  }

  async returnDelivery(
    deliveryId: string,
    candidateId: string | undefined,
    feedback: string,
  ) {
    const view = await this.meetingScheduler.returnDelivery(
      deliveryId,
      candidateId,
      feedback,
    );
    await this.repository.append('delivery-user-returned', {
      deliveryId,
      candidateId: candidateId ?? null,
      feedback,
      attempt: view.attempt,
    });
    await this.snapshotActiveMeeting();
    await this.repository.flush();
    return view;
  }

  inspectDeliveryReview(reviewId: string) {
    return safeCoordinatorReviewProjection(this.coordinatorReviewDriver.inspect(reviewId));
  }

  getDeliveryReviewChunk(reviewId: string, chunkId?: string) {
    const chunk = this.coordinatorReviewDriver.getChunk(reviewId, chunkId);
    if (!chunk) return null;
    if (chunk.requiresUserConfirmation) {
      const { content: _content, ...safe } = chunk;
      return safe;
    }
    return chunk;
  }

  async submitDeliveryChunkReview(
    reviewId: string,
    input: {
      chunkId: string;
      chunkHash: string;
      verdict: 'passed' | 'blocking';
      findings: CoordinatorReviewFinding[];
    },
  ) {
    const session = await this.coordinatorReviewDriver.submitChunkReview(reviewId, input);
    return safeCoordinatorReviewProjection(session);
  }

  async completeDeliveryReview(reviewId: string) {
    const session = await this.coordinatorReviewDriver.complete(reviewId);
    return safeCoordinatorReviewProjection(session);
  }

  async requestDeliveryRework(
    reviewId: string,
    findings: CoordinatorReviewFinding[],
  ) {
    const session = await this.coordinatorReviewDriver.requestRework(reviewId, findings);
    return safeCoordinatorReviewProjection(session);
  }

  async confirmDeliveryReviewEvidence(
    reviewId: string,
    input: { chunkId: string; chunkHash: string; decisionId: string },
  ) {
    const session = await this.coordinatorReviewDriver.confirmEvidence(reviewId, input);
    return safeCoordinatorReviewProjection(session);
  }

  submitWorkerReport(workerId: string, report: import('./worker-protocol.js').WorkReport, sourceAttempt?: number): void {
    this.meetingScheduler.submitWorkerReport(workerId, report, sourceAttempt);
  }

  // Test-only proxy: forward session events to the scheduler for simulation.
  schedulerOnWorkerEvent(workerId: string, e: SessionEvent): void {
    this.meetingScheduler.onWorkerEvent(
      workerId,
      e as unknown as import('./backends/cli-backend.js').BackendSessionEvent,
    );
  }

  submitWorkerDelivery(workerId: string, files: string[], sourceAttempt?: number): void {
    this.meetingScheduler.submitWorkerDelivery(workerId, files, sourceAttempt);
  }

  private notifyCoordinatorReview(briefing: CoordinatorReviewBriefing): void {
    const host = this.hostGroups.get(this.coordinatorHostId)?.getHost();
    if (!host) {
      void this.coordinatorReviewDriver.pauseForDisconnect(briefing.reviewId);
      return;
    }
    if (this.coordinatorTurnActive) this.reviewsAwaitingFirstTurn.add(briefing.reviewId);
    else this.reviewsAwaitingFirstTurn.delete(briefing.reviewId);
    this.ensureReviewStallWatchdog();
    host.sendUserText(
      `(coordinator review)\n${JSON.stringify(briefing)}`,
      'high',
    );
    this.coordinatorTurnActive = true;
  }

  /**
   * A frozen candidate only leaves `coordinator-reviewing` when the Coordinator
   * itself covers every chunk. Without this the briefing was a single
   * fire-and-forget message: a Coordinator that reviewed two chunks and moved on
   * left the delivery — and every task depending on it — stalled forever.
   */
  private async driveCoordinatorReviews(): Promise<void> {
    if (this.closed) return;
    for (const session of this.coordinatorReviewDriver.activeSessions()) {
      if (this.reviewsAwaitingFirstTurn.delete(session.id)) continue;
      try {
        await this.coordinatorReviewDriver.onCoordinatorTurnEnded(session.id);
      } catch (err) {
        this.diagnostics.log('coordinator-review-turn-failed', {
          reviewId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** A silent Coordinator never emits a turn boundary, so time also charges the budget. */
  private ensureReviewStallWatchdog(): void {
    if (this.reviewStallTimer || this.reviewStallTimeoutMs <= 0) return;
    const timer = setInterval(
      () => { void this.sweepStalledReviews(); },
      Math.max(1_000, Math.floor(this.reviewStallTimeoutMs / 2)),
    );
    timer.unref?.();
    this.reviewStallTimer = timer;
  }

  private stopReviewStallWatchdog(): void {
    if (!this.reviewStallTimer) return;
    clearInterval(this.reviewStallTimer);
    this.reviewStallTimer = null;
  }

  private async sweepStalledReviews(): Promise<void> {
    const active = this.closed ? [] : this.coordinatorReviewDriver.activeSessions();
    if (active.length === 0) {
      this.stopReviewStallWatchdog();
      return;
    }
    const deadline = Date.now() - this.reviewStallTimeoutMs;
    for (const session of active) {
      if (session.updatedAt > deadline) continue;
      this.reviewsAwaitingFirstTurn.delete(session.id);
      try {
        await this.coordinatorReviewDriver.onCoordinatorTurnEnded(session.id);
      } catch (err) {
        this.diagnostics.log('coordinator-review-stall-sweep-failed', {
          reviewId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * A paused review is never an implicit pass. Surface it to the user and tell
   * the Coordinator to hand the decision over instead of guessing.
   */
  private async escalateStalledReview(session: CoordinatorReviewSession): Promise<void> {
    const uncoveredChunkIds = listUncoveredCoordinatorReviewChunkIds(session);
    const remainingChunks = session.coverage.totalChunks - session.coverage.reviewedChunks;
    this.safeEmit({
      source: 'system',
      event: {
        kind: 'coordinator-review-stalled',
        reviewId: session.id,
        deliveryId: session.deliveryId,
        ...(session.taskId ? { taskId: session.taskId } : {}),
        reason: session.pauseReason ?? 'user-required',
        uncoveredChunkIds,
        remainingChunks,
      },
    });
    if (session.pauseReason === 'coordinator-disconnected') return;
    this.hostGroups.get(this.coordinatorHostId)?.getHost()?.sendUserText(
      `(coordinator review paused) 审查 ${session.id} 因为 ${session.pauseReason ?? 'user-required'} 已暂停，还有 ${remainingChunks} 个分片没有覆盖：${uncoveredChunkIds.join(', ') || 'none'}。请直接告诉用户审查没走完、卡在哪里，并让用户决定是继续审查还是自己接手。不要声称交付已通过。`,
      'normal',
    );
  }

  /** Resume a paused review. Exposed so the user can restart a stalled Coordinator. */
  async resumeDeliveryReview(reviewId: string) {
    const session = await this.coordinatorReviewDriver.resume(reviewId);
    return safeCoordinatorReviewProjection(session);
  }

  /** After the Coordinator comes back, reviews parked on disconnect resume themselves. */
  private resumeDisconnectedReviews(): void {
    if (this.closed) return;
    if (!this.hostGroups.get(this.coordinatorHostId)?.getHost()) return;
    for (const session of this.coordinatorReviewDriver.pausedSessions()) {
      if (session.pauseReason !== 'coordinator-disconnected') continue;
      void this.coordinatorReviewDriver.resume(session.id).catch((err) => {
        this.diagnostics.log('coordinator-review-resume-failed', {
          reviewId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  activeReviewGate(): ActiveReviewGate | null {
    const [session] = this.coordinatorReviewDriver.activeSessions();
    if (!session) return null;
    return {
      reviewId: session.id,
      deliveryId: session.deliveryId,
      uncoveredChunkIds: listUncoveredCoordinatorReviewChunkIds(session),
      remainingChunks: session.coverage.totalChunks - session.coverage.reviewedChunks,
    };
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
    this.resolvedDecisionContext.set(r.id, {
      id: r.id,
      summary: question ? `${question}: ${condensed}` : condensed,
    });
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

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseFinalMeetingDecision(value: unknown): FinalMeetingDecision | null {
  const record = objectRecord(value);
  const common = (
    typeof record.deliveryId === 'string'
    && typeof record.contentHash === 'string'
    && /^[0-9a-f]{64}$/u.test(record.contentHash)
    && typeof record.decidedAt === 'number'
    && Number.isFinite(record.decidedAt)
  );
  if (!common) return null;
  if (
    record.kind === 'accept'
    && typeof record.integrationHead === 'string'
    && /^[0-9a-f]{40,64}$/u.test(record.integrationHead)
  ) return structuredClone(record as unknown as FinalMeetingDecision);
  if (
    record.kind === 'rework'
    && typeof record.reason === 'string'
    && record.reason.trim().length > 0
    && record.reason.length <= 20_000
    && typeof record.planVersion === 'number'
    && Number.isSafeInteger(record.planVersion)
    && Array.isArray(record.taskIds)
    && record.taskIds.every((entry) => typeof entry === 'string')
  ) return structuredClone(record as unknown as FinalMeetingDecision);
  return null;
}
