// worker-scheduler.ts — owns the N-worker pool: spawning, disposal, DAG
// scheduling, dependency cascades, file-collision tracking, and the bursty
// per-worker → talker update queue.
//
// Extracted out of orchestrator.ts so the orchestrator can stay focused on
// Talker lifecycle, post-meeting recap, decision watchers, memory, and the
// MCP bridge surface. The scheduler is the part that carries all of the
// per-worker mutable state (Map<id, WorkerHandle>, recentEdits, the worker
// id sequence, and per-worker debounce timers).
//
// Coupling to the orchestrator is via constructor callbacks — `getTalker`,
// `isClosed`, `emit`, `buildWorkerMcp` — so the scheduler never imports the
// orchestrator class directly. The bridge interface in meeting-mcp.ts is
// still implemented by the orchestrator; the scheduler just receives a
// pre-bound `buildWorkerMcp(workerId, attempt)` factory.
//
// The dispose / endAll path is idempotent: every native handle (SDK session,
// flush timer, recent-edit pointer) is released exactly once, even if the
// SDK 'ended' event arrives after end() already disposed the same handle.

import type { ClaudeSession } from './claude-session.js';
import type {
  BackendSession,
  BackendSessionEvent,
  BackendSessionSnapshot,
} from './backends/cli-backend.js';
import type {
  NativePermissionRequest,
  PermissionNormalizationResult,
} from './backends/canonical-execution.js';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import {
  coerceWorkspaceModeForBaseline,
  normalizePlanMeetingTasks,
  validatePlan,
  type PlanMeetingTask,
  type PlanMeetingTaskInput,
} from './meeting-tools.js';
import type { PlanRevisionOperation } from './meeting-command.js';
import { CLAUDE_WORKER_PROMPT_SUFFIX, WORKER_PROMPT } from './orchestrator-prompts.js';
import {
  FILE_COLLISION_WINDOW_MS,
  FILE_EDIT_TOOLS,
  condense,
  extractFilePath,
  extractText,
  extractToolUses,
  inferSpecialty,
  summariseToolInput,
  titleFromDescription,
} from './orchestrator-helpers.js';
import type { SteerResult } from './meeting-mcp.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import {
  DirtyWorkspaceWriteBlockedError,
  validateWorkspaceWritePaths,
  type PrepareTaskWorkspaceInput,
  type TaskWorkspace,
  type TaskWorkspaceManager,
} from './task-workspace.js';
import { snapshotDeliveryFiles } from './delivery-snapshot.js';
import {
  compileContextPackage,
  freezeContextPackage,
  hashVisibleContextValue,
  renderContextPackageForWorker,
  verifyContextPackageIntegrity,
  type AuthorizedMeetingContextSource,
  type ContextSelection,
} from './task-context.js';
import {
  backendEffectiveProfileSchema,
  contextPackageSchema,
  taskAuthorityGrantSchema,
  type BackendEffectiveProfile,
  type ContextPackage,
  type TaskAuthorityGrant,
  type TaskExecutionProfile,
  type TaskMessage,
} from './task-collaboration.js';
import type { TaskMailbox } from './task-mailbox.js';
import {
  backendRuntimeSchema,
  type BackendRuntime,
} from './backends/task-profile.js';
import type { DeliveryHarness, DeliveryView } from './delivery-harness.js';
import { reopenFrozenDeliveryCandidateForRework } from './delivery-candidate.js';
import {
  parseWorkerAdapterSignal,
  reworkRequestSchema,
  type AcceptanceCriterion,
  type ReworkRequest,
  type WorkReport,
  type WorkerAdapterSignal,
  type WorkerEvent,
} from './worker-protocol.js';
import type {
  MeetingPlan,
  MeetingPlanNode,
  CoordinatorBriefing,
  OrchestratorEvent,
  RecentFileEdit,
  WorkerHandle,
  WorkerSpecialtyKind,
  WorkerStatusKind,
} from './orchestrator-types.js';
import { decideTaskPermission, DEFAULT_PERMISSION_TIMEOUT_MS } from './permission-broker.js';
import { extendAuthorityAddendum } from './task-authority.js';
import {
  buildFailureFingerprint,
  DEFAULT_TASK_BUDGET,
  evaluateTaskBudget,
  taskBudgetSchema,
  type TaskBudget,
  type TaskBudgetAttempt,
} from './task-budget.js';
import type { CoordinatorReviewSession } from './coordinator-review.js';
import {
  assessTaskRecovery,
  assertRecoveryActionAllowed,
  recoveryRecordFromPlanTask,
  type TaskRecoveryAction,
} from './task-recovery.js';

export type SessionFactory = (
  opts: ConstructorParameters<typeof ClaudeSession>[0],
) => BackendSession;

export interface WorkerSchedulerOpts {
  /** Emit channel — should be the orchestrator's `safeEmit` so events
   *  arriving after end() are dropped at the gate. */
  emit: (e: OrchestratorEvent) => void;
  /** Shared workspace cwd; every worker session inherits this. */
  cwd: string;
  /** Initial trust-mode scope. Live updates go through `setAutoApproveScope`. */
  autoApproveScope: AutoApproveScope;
  /** Env override threaded into ClaudeSession (HOME redirect for the shadow
   *  ~/.claude merge + the env allowlist from settings-loader). */
  workerEnv?: NodeJS.ProcessEnv;
  /** S3: native OS confirmer for destructive tool calls under auto-approve.
   *  Passed straight through to every spawned worker session. */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** ClaudeSession constructor (production = `new ClaudeSession(o)`; tests
   *  inject a stub so cleanup paths run without spawning the real CLI). */
  sessionFactory: SessionFactory;
  /** Meeting-level backend routing. When present, a task can choose its
   * executor independently from the Coordinator backend. */
  resolveSessionFactory?: (backendId?: string) => SessionFactory;
  workspaceManager?: TaskWorkspaceManager;
  /** Pre-bound `buildWorkerMcp(bridge, workerId)` from meeting-mcp.ts.
   *  Owned by the orchestrator because the MCP factory needs the bridge;
   *  the scheduler treats the returned object as opaque mcpServer config. */
  buildWorkerMcp: (workerId: string, attempt: number) => unknown;
  /** Optional computer-use MCP builder. When provided, workers with specialty
   *  'computer-use' get this MCP server mounted alongside the standard
   *  meeting-worker MCP, giving them screenshot/click/type/scroll tools. */
  buildComputerUseMcp?: (workerId: string) => unknown;
  /** Optional browser MCP builder. When provided, ALL workers get this MCP
   *  server mounted, giving them browser_navigate/screenshot/click/type tools
   *  to interact with the embedded browser. */
  buildBrowserMcp?: (workerId: string) => unknown;
  /** Talker accessor — used to push worker-update batches, file-collision
   *  warnings, task_done completions, and cascade-failure notes. Returns
   *  null when the talker hasn't started yet or has been torn down. */
  getTalker: () => BackendSession | null;
  /** Reports orchestrator shutdown. Scheduler uses it to short-circuit
   *  queued setTimeout callbacks that fire after end(). */
  isClosed: () => boolean;
  /** Live read of the user's "播报过滤" toggle. When 'strict', the bursty
   *  per-tool-call worker→talker update stream is dropped before it reaches
   *  the talker session — task_done summaries, failures, file collisions,
   *  and plan updates still flow through their own direct paths. Returns
   *  'off' if the caller wants the raw stream. Read on each flush so a live
   *  toggle takes effect on the next batch without restarting the meeting. */
  getSpeechFilterMode: () => 'strict' | 'off';
  meetingId?: string;
  defaultBackendId?: string;
  deliveryHarness?: DeliveryHarness;
  /** Meeting-private evidence directory, outside task worktrees. */
  deliveryArtifactRoot?: string;
  /** Waits until previously emitted canonical events are durable. */
  flushEvents?: () => Promise<void>;
  getIntegrationHead?: () => string | undefined;
  /** Durable structural plan version restored with the meeting snapshot. */
  initialPlanVersion?: number;
  /** Orchestrator-owned, read-only source of user-visible Meeting context. */
  getAuthorizedTaskContextSource?: (
    taskId: string,
    selection: ContextSelection,
  ) => Promise<AuthorizedMeetingContextSource>;
  /** Appends and flushes context-package-frozen before side effects. */
  persistContextPackage?: (contextPackage: ContextPackage) => Promise<void>;
  /** Production HostGroups require context compilation; narrow unit tests may
   * omit the source seam to exercise legacy Scheduler behavior. */
  contextCompilerRequired?: boolean;
  /** Compiles one requested profile from version facts without creating a
   * Backend session or reading credentials. */
  compileTaskProfile?: (
    requested: TaskExecutionProfile,
  ) => Promise<{
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }>;
  /** Appends and flushes backend-profile-compiled before workspace creation. */
  persistTaskProfile?: (input: {
    taskId: string;
    attempt: number;
    requestedProfile: TaskExecutionProfile;
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }) => Promise<void>;
  /** Production HostGroups require profile compilation; narrow tests may omit
   * the seam to exercise pre-collaboration Scheduler behavior. */
  taskProfileCompilerRequired?: boolean;
  /** Compiles an attempt-bound authority only after workspace allocation. */
  compileTaskAuthority?: (input: {
    taskId: string;
    attempt: number;
    planVersion: number;
    approvalDecisionId: string;
    workspaceRoot: string;
    authorityRequest: PlanMeetingTask['authorityRequest'];
    approvedAt: number;
  }) => TaskAuthorityGrant;
  /** Appends and flushes task-authority-compiled before session creation. */
  persistTaskAuthority?: (input: {
    taskId: string;
    attempt: number;
    authorityGrant: TaskAuthorityGrant;
  }) => Promise<void>;
  /** Converts a provider-native request without executing or reading secrets. */
  normalizePermissionRequest?: (
    backendId: string,
    native: NativePermissionRequest,
  ) => PermissionNormalizationResult;
  /** Canonical permission decisions are durable before any allow/deny reply. */
  persistPermissionDecision?: (input: {
    taskId: string;
    attempt: number;
    nativeRequestId: string;
    decision: 'allow' | 'ask-user' | 'deny';
    reason: string;
    safeInput: Record<string, unknown>;
    grantHash?: string;
  }) => Promise<void>;
  /** Production Meeting plans require an approved grant before tool sessions. */
  taskAuthorityCompilerRequired?: boolean;
  /** Shared durable task mailbox. Production collaboration routing refuses to
   * bypass this seam; narrow legacy tests may omit it when no message is sent. */
  taskMailbox?: TaskMailbox;
}

const COMPUTER_USE_WORKER_PROMPT = `

你拥有 Computer Use 能力——可以截屏、移动鼠标、点击、打字、按键、滚动来操控用户的桌面。

工作流程：
1. 先调 screenshot 截屏，观察当前屏幕状态
2. 分析截图中的 UI 元素位置（坐标是屏幕像素）
3. 使用 mouse_click / keyboard_type / keyboard_press / scroll 执行操作
4. 再次 screenshot 验证操作结果
5. 重复直到任务完成

注意事项：
- 坐标是 Retina 屏幕像素坐标，会自动缩放到逻辑坐标
- 先 screenshot 看到界面后再操作，不要盲操作
- 每步操作后 screenshot 验证，确保操作成功
- 如果操作需要辅助功能权限（Accessibility），工具会返回错误提示
- 不要在 screenshot 中暴露或朗读用户的敏感信息`;

const WORK_REPORT_RECOVERY_MESSAGE = [
  '[AhaStation protocol correction]',
  'Your previous turn ended without a valid mandatory WorkReport.',
  'Do not repeat the implementation or run more tools.',
  'Now submit the authoritative report with meeting-worker submit_work_report,',
  'or output exactly one fenced ```work-report JSON object matching the required schema.',
  'Exact shape: {"status":"completed","summary":"short result","files":[{"path":"relative/path","action":"created"}],"tests":[{"command":"actual command","status":"passed","summary":"actual result"}],"unresolved":[]}.',
  'tests.status must be passed, failed, or not-run. Every unresolved item must be {"message":"description","blocking":true} rather than a string.',
  'This is the only automatic correction; another missing report will fail the task.',
].join(' ');

const MAX_CONCURRENT_WORKERS = 4;
const QUEUED_UPDATE_FLUSH_MS = 1200;
const QUEUED_UPDATE_MAX = 8;
// B1 stall watchdog: a worker that produces no SDK event for this long while
// still 'running' is treated as stalled (hung tool, awaiting an invisible
// native dialog, infinite loop). We emit one `worker-stalled` event so the
// renderer can speak it — otherwise a hang produces zero events and the user
// waits blind. Swept on a coarse interval; only runs while a worker is alive.
const STALL_THRESHOLD_MS = 45_000;
const STALL_SWEEP_MS = 15_000;
// Parked slot-holders (verifying / reviewing / coordinator-reviewing /
// awaiting-acceptance / integration-queued / integrating / integration-conflict)
// hold a concurrency slot but emit no SDK activity, so the running-worker sweep
// is blind to them. Without coverage a swallowed throw or a forgotten
// acceptance silently consumes a slot forever. See sweepParked.
const PARKED_SLOT_STATUSES: ReadonlySet<WorkerStatusKind> = new Set([
  'verifying',
  'reviewing',
  'coordinator-reviewing',
  'awaiting-acceptance',
  'integration-queued',
  'integrating',
  'integration-conflict',
]);
/**
 * Statuses that may satisfy dependencyGate: 'reviewed' after verification +
 * independent review have passed. Mid Coordinator coverage and integration
 * conflicts must not release dependents.
 */
const REVIEWED_GATE_STATUSES: ReadonlySet<WorkerStatusKind> = new Set([
  'awaiting-acceptance',
  'integration-queued',
  'integrating',
  'accepted',
  'done',
]);
// Should-be-transient parks. If one persists this long the harness is hung on
// an await that will never settle (a throw Fix 2's try/catch didn't catch, e.g.
// a never-settling review driver) - fail the attempt closed and free the slot.
const PARKED_TRANSIENT_STATUSES: ReadonlySet<WorkerStatusKind> = new Set([
  'verifying',
  'integrating',
]);
const PARKED_ALERT_MS = 60_000;
const PARKED_FAIL_CLOSED_MS = 600_000;
const TASK_HISTORY_MAX = 50;
const TASK_MESSAGE_MAX_CHARS = 100_000;
/** Identical authority denials before the scheduler fails the attempt closed. */
const AUTHORITY_DENY_STREAK_LIMIT = 3;
/** Approval cards a single attempt may have in flight before we stop tracking
 *  them for addendum promotion. Cards still work; they just keep asking. */
const PENDING_AUTHORITY_ASK_MAX = 32;

function boundedTaskText(
  value: string,
  label: string,
  maxChars = TASK_MESSAGE_MAX_CHARS,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxChars) {
    throw new Error(`${label} exceeds ${maxChars} characters`);
  }
  return normalized;
}

function extractFailedVerificationChecks(checks: unknown[] | undefined): string[] {
  if (!checks) return [];
  return checks.flatMap((check) => {
    if (typeof check === 'string') return [check];
    if (!check || typeof check !== 'object') return [];
    const record = check as Record<string, unknown>;
    const passed = record.passed === true || record.status === 'passed';
    if (passed) return [];
    return [
      String(
        record.summary
        ?? record.description
        ?? record.command
        ?? record.status
        ?? 'verification failed',
      ).slice(0, 4_000),
    ];
  });
}

function renderReworkRequest(request: ReworkRequest): string {
  const chunks = request.affectedChunks.length > 0
    ? request.affectedChunks.map((chunk) => `- ${chunk.path} (${chunk.chunkId})`).join('\n')
    : '- No specific file chunk was identified; inspect the verified diff.';
  const checks = request.failedChecks.length > 0
    ? request.failedChecks.map((check) => `- ${check}`).join('\n')
    : '- Re-run every approved acceptance check.';
  return [
    'Coordinator rework request (fresh immutable attempt).',
    '',
    'Findings:',
    ...request.findings.map((finding) => `- ${finding}`),
    '',
    'Affected chunks:',
    chunks,
    '',
    'Failed checks:',
    checks,
    '',
    'Expected behavior:',
    ...request.expectedBehavior.map((item) => `- ${item}`),
    '',
    `Authority request hash (unchanged): ${request.authorityGrantHash}`,
    'Do not widen paths, commands, network access, environment access, or tool kinds.',
  ].join('\n');
}

function budgetStateFor(handle: WorkerHandle): NonNullable<MeetingPlanNode['budgetState']> {
  let totalTokens = 0;
  let totalDurationMs = 0;
  for (const attempt of handle.budgetAttempts) {
    totalTokens += attempt.tokenCost ?? attempt.reservedTokenCost ?? 0;
    totalDurationMs += attempt.durationMs;
  }
  let stagnantAttempts = 0;
  let fingerprint: string | null = null;
  for (const attempt of [...handle.budgetAttempts].reverse()) {
    if (!attempt.failureFingerprint) break;
    fingerprint ??= attempt.failureFingerprint;
    if (attempt.failureFingerprint !== fingerprint) break;
    stagnantAttempts += 1;
  }
  return {
    attempts: handle.budgetAttempts.length,
    totalTokens,
    totalDurationMs,
    stagnantAttempts,
    ...(handle.budgetPauseReason ? { reason: handle.budgetPauseReason } : {}),
  };
}

class TaskProfileCompilationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TaskProfileCompilationError';
  }
}
const ASSISTANT_CONDENSE_CHARS = 140;
const ASSISTANT_DESCRIBE_MAX = 200;

export class WorkerScheduler {
  private workers: Map<string, WorkerHandle> = new Map();
  private recentEdits: Map<string, RecentFileEdit> = new Map();
  private workerIdSeq = 0;
  private autoApproveScope: AutoApproveScope;
  private stallTimer: NodeJS.Timeout | null = null;
  private capacityNotified = false;
  private launching = new Set<string>();
  private planVersion: number;
  private readonly opts: WorkerSchedulerOpts;
  private talkerProvider: () => BackendSession | null;
  private readonly steeringMessageByWorker = new Map<string, string>();
  private readonly pendingMailboxAckByWorker = new Map<string, string>();
  private readonly mailboxAckInFlightByWorker = new Map<string, Promise<void>>();
  /** Fail-closed timers for ask-user permission cards on backends without
   *  their own broker (claude-code / codex / kimi / qoder). OpenCode is
   *  excluded - its adapter owns PermissionBroker which already arms this
   *  timeout. Keyed by native request id. */
  private readonly permissionTimers = new Map<string, { handleId: string; timer: ReturnType<typeof setTimeout> }>();
  private readonly automaticReworkByAttempt = new Map<string, Promise<void>>();

  constructor(opts: WorkerSchedulerOpts) {
    this.opts = opts;
    this.talkerProvider = opts.getTalker;
    this.autoApproveScope = opts.autoApproveScope;
    this.planVersion = Number.isSafeInteger(opts.initialPlanVersion)
      && (opts.initialPlanVersion ?? 0) >= 0
      ? opts.initialPlanVersion!
      : 0;
  }

  /** Rebind progress/result delivery when coordination moves to another Host. */
  setTalkerProvider(provider: () => BackendSession | null): void {
    this.talkerProvider = provider;
  }

  // ---------------------------------------------------------------------------
  // Mutators

  setAutoApproveScope(scope: AutoApproveScope): void {
    this.autoApproveScope = scope;
    for (const handle of this.workers.values()) {
      handle.session?.setAutoApproveScope?.(scope);
    }
  }

  // ---------------------------------------------------------------------------
  // Queries — mirrored on OrchestratorBridge; orchestrator just delegates.

  hasWorker(workerId: string): boolean {
    return this.workers.has(workerId);
  }

  activeWorkerIds(): string[] {
    const out: string[] = [];
    for (const handle of this.workers.values()) {
      if (handle.status === 'running') out.push(handle.id);
    }
    return out;
  }

  describeWorkers(workerId?: string): string {
    const ids = workerId ? [workerId] : Array.from(this.workers.keys());
    const lines: string[] = [`planVersion=${this.planVersion}`];
    for (const id of ids) {
      const h = this.workers.get(id);
      if (!h) { lines.push(`${id}: unknown`); continue; }
      const parts: string[] = [`${id} [${h.title}] status=${h.status}`];
      if (h.live.currentTool) {
        parts.push(`tool=${h.live.currentTool}${h.live.currentToolInput ? `(${h.live.currentToolInput})` : ''}`);
      }
      if (h.live.lastAssistantText) {
        const t = h.live.lastAssistantText.length > ASSISTANT_DESCRIBE_MAX
          ? `${h.live.lastAssistantText.slice(0, ASSISTANT_DESCRIBE_MAX)}…`
          : h.live.lastAssistantText;
        parts.push(`thought="${t}"`);
      }
      if (h.summary && (h.status === 'accepted' || h.status === 'done')) parts.push(`summary="${h.summary}"`);
      if (h.deps.length > 0) {
        const pending = h.deps.filter((d) => {
          const dependency = this.workers.get(d);
          return !dependency || !this.dependencyGateSatisfied(dependency);
        });
        if (pending.length > 0) parts.push(`waiting_on=${pending.join(',')}`);
      }
      lines.push(parts.join(' | '));
    }
    if (lines.length === 1) lines.push('no workers');
    return lines.join('\n');
  }

  snapshot(): Array<{
    id: string;
    title: string;
    prompt: string;
    status: WorkerStatusKind | 'interrupted';
    deps: string[];
    supersedesTaskId?: string;
    executorBackendId?: string;
    writePaths?: string[];
    executionProfile?: PlanMeetingTask['executionProfile'];
    contextSelection?: PlanMeetingTask['contextSelection'];
    workspaceMode?: PlanMeetingTask['workspaceMode'];
    authorityRequest?: PlanMeetingTask['authorityRequest'];
    dependencyGate?: 'reviewed' | 'accepted';
    budget?: TaskBudget;
    budgetAttempts?: TaskBudgetAttempt[];
    budgetPauseReason?: string;
    budgetState?: NonNullable<MeetingPlanNode['budgetState']>;
    contextPackage?: ContextPackage;
    contextPackageHash?: string;
    backendRuntime?: BackendRuntime;
    effectiveProfile?: BackendEffectiveProfile;
    authorityGrant?: TaskAuthorityGrant;
    approvalDecisionId?: string;
    approvalRecordedAt?: number;
    approvedPlanVersion?: number;
    acceptanceCriteria?: AcceptanceCriterion[];
    workspace?: TaskWorkspace;
    workspaceDiagnostic?: WorkerHandle['workspaceDiagnostic'];
    backendSession?: BackendSessionSnapshot;
    deliveryId?: string;
    delivery?: DeliveryView;
    attempt?: number;
    summary?: string;
    report?: WorkReport;
    startedAt?: number;
  }> {
    return Array.from(this.workers.values()).map((handle) => ({
      id: handle.id,
      title: handle.title,
      prompt: handle.prompt,
      status: handle.status,
      deps: [...handle.deps],
      supersedesTaskId: handle.supersedesTaskId,
      executorBackendId: handle.executorBackendId,
      writePaths: handle.writePaths ? [...handle.writePaths] : undefined,
      executionProfile: handle.executionProfile ? structuredClone(handle.executionProfile) : undefined,
      contextSelection: handle.contextSelection ? structuredClone(handle.contextSelection) : undefined,
      workspaceMode: handle.workspaceMode,
      authorityRequest: handle.authorityRequest ? structuredClone(handle.authorityRequest) : undefined,
      dependencyGate: handle.dependencyGate,
      budget: structuredClone(handle.budget),
      budgetAttempts: structuredClone(handle.budgetAttempts),
      budgetPauseReason: handle.budgetPauseReason,
      budgetState: budgetStateFor(handle),
      contextPackage: handle.contextPackage ? structuredClone(handle.contextPackage) : undefined,
      contextPackageHash: handle.contextPackageHash,
      backendRuntime: handle.backendRuntime ? structuredClone(handle.backendRuntime) : undefined,
      effectiveProfile: handle.effectiveProfile ? structuredClone(handle.effectiveProfile) : undefined,
      authorityGrant: handle.authorityGrant ? structuredClone(handle.authorityGrant) : undefined,
      approvalDecisionId: handle.approvalDecisionId,
      approvalRecordedAt: handle.approvalRecordedAt,
      approvedPlanVersion: handle.approvedPlanVersion,
      acceptanceCriteria: handle.acceptanceCriteria
        ? structuredClone(handle.acceptanceCriteria)
        : undefined,
      workspace: handle.workspace
        ? structuredClone(handle.workspace)
        : undefined,
      workspaceDiagnostic: handle.workspaceDiagnostic
        ? structuredClone(handle.workspaceDiagnostic)
        : undefined,
      backendSession: handle.session?.snapshot?.()
        ?? (handle.backendSession ? structuredClone(handle.backendSession) : undefined),
      deliveryId: handle.deliveryId ?? undefined,
      delivery: handle.deliveryId
        ? this.opts.deliveryHarness?.snapshot(handle.deliveryId)
        : undefined,
      attempt: handle.attempt,
      summary: handle.summary || undefined,
      report: handle.report ? structuredClone(handle.report) : undefined,
      startedAt: handle.startedAt,
    }));
  }

  getPlanVersion(): number {
    return this.planVersion;
  }

  /** Create immutable, versioned replacements for already accepted tasks.
   * Existing accepted handles and their integrated commits are never reset.
   * Replacement tasks keep the exact approved execution/authority envelope
   * and start from the queue's current accepted integration head. */
  createFinalDeliveryRework(
    reason: string,
    deliveryHash: string,
  ): { planVersion: number; taskIds: string[] } {
    const normalizedReason = boundedTaskText(reason, 'final delivery rework reason', 20_000);
    if (!/^[0-9a-f]{64}$/u.test(deliveryHash)) {
      throw new Error('final delivery hash is invalid');
    }
    const accepted = Array.from(this.workers.values())
      .filter((handle) => handle.status === 'accepted')
      .sort((left, right) => left.id.localeCompare(right.id));
    if (accepted.length === 0) throw new Error('final delivery has no accepted tasks to rework');

    const nextPlanVersion = this.planVersion + 1;
    const taskIds: string[] = [];
    for (const original of accepted) {
      const baseId = `${original.id}-rework-v${nextPlanVersion}`;
      let id = baseId;
      let suffix = 2;
      while (this.workers.has(id)) id = `${baseId}-${suffix++}`;
      this.registerHandle({
        id,
        title: `${original.title} · 返工 v${nextPlanVersion}`,
        prompt: [
          `This is a user-requested replacement for immutable accepted task ${original.id}.`,
          `The rejected final Meeting delivery hash is ${deliveryHash}.`,
          `Reason: ${normalizedReason}`,
          'Start from the current accepted Meeting integration head. Do not reset, revert, or rewrite prior accepted commits.',
          '',
          original.prompt,
        ].join('\n'),
        deps: [],
        supersedesTaskId: original.id,
        specialty: original.specialty,
        executorBackendId: original.executorBackendId,
        writePaths: original.writePaths ? [...original.writePaths] : undefined,
        executionProfile: original.executionProfile
          ? structuredClone(original.executionProfile)
          : undefined,
        contextSelection: original.contextSelection
          ? structuredClone(original.contextSelection)
          : undefined,
        workspaceMode: original.workspaceMode,
        authorityRequest: original.authorityRequest
          ? structuredClone(original.authorityRequest)
          : undefined,
        dependencyGate: original.dependencyGate,
        budget: structuredClone(original.budget),
        approvalDecisionId: original.approvalDecisionId,
        approvalRecordedAt: original.approvalRecordedAt,
        approvedPlanVersion: nextPlanVersion,
        acceptanceCriteria: original.acceptanceCriteria
          ? structuredClone(original.acceptanceCriteria)
          : undefined,
      });
      taskIds.push(id);
    }
    this.planVersion = nextPlanVersion;
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { planVersion: nextPlanVersion, taskIds };
  }

  getAcceptedDependencyReports(taskId: string): Array<{
    taskId: string;
    reportHash: string;
    summary: string;
  }> {
    const task = this.workers.get(taskId);
    if (!task) return [];
    return task.deps.flatMap((dependencyId) => {
      const dependency = this.workers.get(dependencyId);
      if (!dependency || !dependency.report || !this.dependencyGateSatisfied(dependency)) {
        return [];
      }
      return [{
        taskId: dependencyId,
        reportHash: hashVisibleContextValue(dependency.report),
        summary: dependency.report.summary,
      }];
    });
  }

  /** Hydrate recovered task shells and delivery evidence without spawning any
   * Worker. The renderer can inspect the previous attempts immediately, but
   * external side effects are never replayed until the user chooses an
   * explicit recovery action. */
  restoreTasks(tasks: Array<Record<string, unknown>>): void {
    for (const task of tasks) {
      const id = typeof task.id === 'string' ? task.id : '';
      const prompt = typeof task.prompt === 'string' ? task.prompt : '';
      if (!id || !prompt || this.workers.has(id)) continue;
      let normalized: PlanMeetingTask;
      try {
        normalized = normalizePlanMeetingTasks([{
          id,
          title: typeof task.title === 'string' ? task.title : id,
          prompt,
          deps: Array.isArray(task.deps) ? task.deps.map(String) : [],
          executorBackendId: typeof task.executorBackendId === 'string'
            ? task.executorBackendId
            : undefined,
          writePaths: Array.isArray(task.writePaths) ? task.writePaths.map(String) : undefined,
          executionProfile: task.executionProfile,
          contextSelection: task.contextSelection,
          workspaceMode: task.workspaceMode,
          authorityRequest: task.authorityRequest,
          dependencyGate: task.dependencyGate === 'reviewed' || task.dependencyGate === 'accepted'
            ? task.dependencyGate
            : undefined,
          budget: task.budget,
          acceptanceCriteria: task.acceptanceCriteria,
          requiresDecision: task.requiresDecision,
        }], this.opts.defaultBackendId ?? 'claude-code').tasks[0];
      } catch {
        // Corrupt recovered execution boundaries are not made executable.
        continue;
      }
      this.registerHandle({
        id: normalized.id,
        title: normalized.title,
        prompt: normalized.prompt,
        deps: normalized.deps ?? [],
        supersedesTaskId: typeof task.supersedesTaskId === 'string'
          ? task.supersedesTaskId
          : undefined,
        specialty: inferSpecialty(`${String(task.title ?? id)} ${prompt}`),
        executorBackendId: normalized.executorBackendId,
        writePaths: normalized.writePaths,
        executionProfile: normalized.executionProfile,
        contextSelection: normalized.contextSelection,
        workspaceMode: normalized.workspaceMode,
        authorityRequest: normalized.authorityRequest,
        dependencyGate: normalized.dependencyGate,
        budget: normalized.budget,
        approvalDecisionId: typeof task.approvalDecisionId === 'string'
          ? task.approvalDecisionId
          : undefined,
        approvalRecordedAt: typeof task.approvalRecordedAt === 'number'
          ? task.approvalRecordedAt
          : undefined,
        approvedPlanVersion: typeof task.approvedPlanVersion === 'number'
          ? task.approvedPlanVersion
          : undefined,
        acceptanceCriteria: normalized.acceptanceCriteria,
      });
      const handle = this.workers.get(id)!;
      const recoveredContext = contextPackageSchema.safeParse(task.contextPackage);
      if (
        recoveredContext.success
        && recoveredContext.data.taskId === id
        && recoveredContext.data.packageHash === task.contextPackageHash
        && verifyContextPackageIntegrity(recoveredContext.data)
      ) {
        handle.contextPackage = freezeContextPackage(recoveredContext.data);
        handle.contextPackageHash = recoveredContext.data.packageHash;
      }
      const recoveredRuntime = backendRuntimeSchema.safeParse(task.backendRuntime);
      const recoveredProfile = backendEffectiveProfileSchema.safeParse(task.effectiveProfile);
      const recoveredAuthority = taskAuthorityGrantSchema.safeParse(task.authorityGrant);
      if (
        recoveredRuntime.success
        && recoveredProfile.success
        && recoveredRuntime.data.backendId === handle.backendId
        && recoveredProfile.data.backendId === handle.backendId
        && recoveredRuntime.data.runtimeVersion === recoveredProfile.data.runtimeVersion
      ) {
        handle.backendRuntime = structuredClone(recoveredRuntime.data);
        handle.effectiveProfile = structuredClone(recoveredProfile.data);
      }
      if (recoveredAuthority.success && recoveredAuthority.data.taskId === id) {
        handle.authorityGrant = structuredClone(recoveredAuthority.data);
        handle.approvalDecisionId = recoveredAuthority.data.approvalDecisionId;
        handle.approvalRecordedAt = recoveredAuthority.data.approvedAt;
      }
      const backendSession = task.backendSession;
      if (
        backendSession
        && typeof backendSession === 'object'
        && typeof (backendSession as BackendSessionSnapshot).protocol === 'string'
        && typeof (backendSession as BackendSessionSnapshot).sessionId === 'string'
        && (backendSession as BackendSessionSnapshot).protocol.length <= 100
        && (backendSession as BackendSessionSnapshot).sessionId.length <= 1_000
      ) {
        handle.backendSession = structuredClone(backendSession as BackendSessionSnapshot);
      }
      const rawStatus = typeof task.status === 'string' ? task.status : 'interrupted';
      handle.status = (
        rawStatus === 'accepted'
        || rawStatus === 'failed'
        || rawStatus === 'budget-paused'
        || rawStatus === 'integration-conflict'
      ) ? rawStatus : 'interrupted';
      handle.summary = typeof task.summary === 'string' ? task.summary : '';
      if (Array.isArray(task.budgetAttempts)) {
        handle.budgetAttempts = task.budgetAttempts
          .filter((entry): entry is TaskBudgetAttempt => Boolean(entry && typeof entry === 'object'))
          .map((entry) => structuredClone(entry));
      }
      handle.budgetPauseReason = typeof task.budgetPauseReason === 'string'
        ? task.budgetPauseReason
        : undefined;
      handle.attempt = typeof task.attempt === 'number' && Number.isSafeInteger(task.attempt)
        ? Math.max(1, task.attempt)
        : 1;
      const delivery = task.delivery;
      if (
        delivery
        && typeof delivery === 'object'
        && typeof (delivery as DeliveryView).id === 'string'
        && this.opts.deliveryHarness
      ) {
        const restored = this.opts.deliveryHarness.restore(delivery as DeliveryView);
        handle.deliveryId = restored.id;
        handle.attempt = restored.attempt;
      } else if (typeof task.deliveryId === 'string') {
        handle.deliveryId = task.deliveryId;
      }
      handle.live.lastUpdateTs = Date.now();
    }
    if (this.workers.size > 0 && this.planVersion === 0) this.planVersion = 1;
  }

  emitRecoveredState(): void {
    this.emitPlanUpdate();
    if (!this.opts.deliveryHarness) return;
    for (const handle of this.workers.values()) {
      if (!handle.deliveryId) continue;
      const delivery = this.opts.deliveryHarness.snapshot(handle.deliveryId);
      if (!delivery) continue;
      this.opts.emit({
        source: 'system',
        event: {
          kind: 'delivery-status',
          workerId: handle.id,
          taskId: handle.currentTaskId,
          delivery,
        },
      });
    }
  }

  async resolveRecoveredTask(
    taskId: string,
    action: Exclude<TaskRecoveryAction, 'resolve-integration-conflict'>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const handle = this.workers.get(taskId);
    if (!handle) return { ok: false, error: 'interrupted task not found' };
    if (handle.status !== 'interrupted' && handle.status !== 'budget-paused') {
      return { ok: false, error: `task is already ${handle.status}` };
    }
    try {
      assertRecoveryActionAllowed(
        recoveryRecordFromPlanTask({
          id: handle.id,
          title: handle.title,
          prompt: handle.prompt,
          deps: [...handle.deps],
          executorBackendId: handle.executorBackendId,
          writePaths: handle.writePaths ? [...handle.writePaths] : undefined,
          executionProfile: structuredClone(handle.executionProfile!),
          contextSelection: structuredClone(handle.contextSelection!),
          workspaceMode: handle.workspaceMode!,
          authorityRequest: structuredClone(handle.authorityRequest!),
          dependencyGate: handle.dependencyGate,
          budget: structuredClone(handle.budget),
          acceptanceCriteria: handle.acceptanceCriteria
            ? structuredClone(handle.acceptanceCriteria)
            : undefined,
        }, handle.status),
        action,
      );
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (action === 'abandon-task') {
      this.disposeWorker(handle, 'failed', 'Abandoned by the user after recovery.');
      this.emitPlanUpdate();
      this.cascadeFailure(handle.id);
      return { ok: true };
    }
    if (handle.deliveryId && this.opts.deliveryHarness) {
      const restored = this.opts.deliveryHarness.snapshot(handle.deliveryId);
      if (restored?.status === 'interrupted') {
        const view = await this.opts.deliveryHarness.decide(handle.deliveryId, {
          kind: 'resume-after-interruption',
          mode: action === 'retry-attempt' ? 'retry' : 'continue',
        });
        handle.attempt = view.attempt;
        this.applyDeliveryView(handle, view);
      }
    } else {
      // Older snapshots did not persist DeliveryView. Start a fresh delivery
      // while retaining the task identity and explicit recovery semantics.
      handle.deliveryId = null;
    }
    handle.report = null;
    if (action === 'retry-attempt') handle.backendSession = undefined;
    handle.backendRuntime = undefined;
    handle.effectiveProfile = undefined;
    handle.authorityGrant = undefined;
    handle.transportEnded = false;
    handle.summary = '';
    handle.prompt = action === 'continue-read-only'
      ? `(read-only recovery continuation) Continue from the durable Backend session. This attempt has explicit read/search-only authority; do not request side effects.\n\n${handle.prompt}`
      : action === 'continue-side-effecting'
        ? `(user-authorized recovery continuation) Inspect the existing workspace and durable evidence before continuing. Do not repeat an external side effect unless its durable acknowledgement is absent.\n\n${handle.prompt}`
      : `(recovery retry) This is a new attempt. Re-check the workspace before repeating any external side effect.\n\n${handle.prompt}`;
    handle.status = 'pending';
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { ok: true };
  }

  /** Snapshot every worker's un-flushed update buffer so the orchestrator
   *  can fold them into a final talker line at end(). */
  collectFinalBufferedLines(): string[] {
    const out: string[] = [];
    for (const handle of this.workers.values()) {
      if (handle.bufferedUpdates.length > 0) {
        out.push(`[${handle.title}] ${handle.bufferedUpdates.join(' / ')}`);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Computer Use screenshot injection

  /** Inject a screenshot PNG into a specific worker's session input queue
   *  as an image content block. Called by the computer-use MCP's screenshot
   *  tool after capturing the screen — the tool result itself is text-only
   *  (MCP doesn't support image content blocks), so we push the image
   *  directly into the worker's conversation. */
  injectScreenshotToWorker(workerId: string, data: { pngBase64: string; width: number; height: number }): void {
    const handle = this.workers.get(workerId);
    if (!handle?.session) return;
    handle.session.sendUserContent([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.pngBase64 } },
      { type: 'text', text: `Screenshot (${data.width}×${data.height}). Analyze this image to determine the next action.` },
    ], 'normal');
  }

  // ---------------------------------------------------------------------------
  // Broadcast operations to every worker session

  /** Try to land a permission resolution on whichever worker session holds
   *  the pending entry. Talker resolutions are handled separately by the
   *  orchestrator. */
  resolvePermissionInAny(id: string, decision: 'allow' | 'deny', message?: string): void {
    // The user answered (or the host resolved) - cancel the fail-closed timer.
    this.clearPermissionTimeout(id);
    for (const handle of this.workers.values()) {
      const asked = handle.pendingAuthorityAsks?.get(id);
      if (asked) {
        handle.pendingAuthorityAsks!.delete(id);
        if (decision === 'allow' && handle.authorityGrant) {
          handle.authorityAddendum = extendAuthorityAddendum(
            handle.authorityGrant,
            asked,
            handle.authorityAddendum,
          );
        }
      }
      handle.session?.resolvePermission(id, decision, message);
    }
  }

  interruptAll(): Promise<void>[] {
    const tasks: Promise<void>[] = [];
    for (const handle of this.workers.values()) {
      if (handle.session) tasks.push(handle.session.interrupt('user'));
    }
    return tasks;
  }

  async interruptTask(
    taskId: string,
    reason = 'Interrupted by the user.',
  ): Promise<{ ok: true; message: TaskMessage } | { ok: false; error: string }> {
    const handle = this.workers.get(taskId);
    if (!handle) return { ok: false, error: 'worker not found' };
    if (!handle.session || handle.status !== 'running') {
      return { ok: false, error: `worker cannot be interrupted in ${handle.status}` };
    }
    const normalizedReason = boundedTaskText(reason, 'interrupt reason', 20_000);
    const mailbox = this.requireTaskMailbox();
    const message = await mailbox.enqueue({
      taskId: handle.id,
      attempt: handle.attempt,
      sender: 'coordinator',
      kind: 'interrupt',
      payload: { reason: normalizedReason },
    });
    const session = handle.session;
    try {
      handle.backendSession = session.snapshot?.() ?? handle.backendSession;
      await session.interrupt('user');
      await mailbox.markDelivered(handle.id, message.id);
      await mailbox.acknowledge(handle.id, message.id);
      handle.backendSession = session.snapshot?.() ?? handle.backendSession;
      if (handle.session === session && handle.status === 'running') {
        handle.status = 'interrupted';
        this.disposeWorker(handle, 'interrupted', reason);
        this.emitPlanUpdate();
      }
      return { ok: true, message: mailbox.get(handle.id, message.id)! };
    } catch (error) {
      await mailbox.markFailed(handle.id, message.id).catch(() => undefined);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  markRecoveredIntegrationConflict(taskId: string): boolean {
    const handle = this.workers.get(taskId);
    if (!handle || handle.status !== 'interrupted') return false;
    handle.status = 'integration-conflict';
    this.emitPlanUpdate();
    return true;
  }

  clearRecoveredIntegrationConflict(taskId: string): boolean {
    const handle = this.workers.get(taskId);
    if (!handle || handle.status !== 'integration-conflict') return false;
    handle.status = 'interrupted';
    this.emitPlanUpdate();
    return true;
  }

  /** Compatibility entry point used by the existing IPC. It is deliberately
   * routed through the same durable mailbox as the typed Task command. */
  interruptWorker(workerId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.interruptTask(workerId, reason).then((result) => (
      result.ok ? { ok: true as const } : result
    ));
  }

  setPermissionModeAll(
    mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
  ): Promise<void>[] {
    const tasks: Promise<void>[] = [];
    for (const handle of this.workers.values()) {
      if (handle.session?.setPermissionMode) tasks.push(handle.session.setPermissionMode(mode));
    }
    return tasks;
  }

  // ---------------------------------------------------------------------------
  // Delegation entry points — the OrchestratorBridge layer delegates here.

  delegateSingleTask(description: string): {
    workerId: string;
    specialty: WorkerSpecialtyKind;
    reused: boolean;
  } {
    const title = titleFromDescription(description);
    const specialty = inferSpecialty(`${title} ${description}`);
    const reusable = this.findReusableWorker(specialty);
    if (reusable) {
      this.reassignWorker(reusable, { title, prompt: description });
      return { workerId: reusable.id, specialty, reused: true };
    }
    const id = this.nextWorkerId('task');
    this.registerHandle({ id, title, prompt: description, deps: [], specialty });
    this.planVersion += 1;
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { workerId: id, specialty, reused: false };
  }

  installPlan(
    inputs: PlanMeetingTaskInput[],
    approval?: { decisionId: string; approvedAt: number },
  ): { ok: true } | { ok: false; error: string } {
    let tasks: PlanMeetingTask[];
    try {
      tasks = normalizePlanMeetingTasks(
        inputs,
        this.opts.defaultBackendId ?? 'claude-code',
        {
          cwd: this.opts.cwd,
          baselineKind: typeof this.opts.workspaceManager?.inspectBaseline === 'function'
            ? this.opts.workspaceManager.inspectBaseline().kind
            : undefined,
        },
      ).tasks;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    tasks = this.adaptTasksForWorkspaceBaseline(tasks);
    const idAllocation = this.allocateInstallTaskIds(tasks);
    if (!idAllocation.ok) return idAllocation;
    tasks = idAllocation.tasks;
    const err = validatePlan(tasks, {
      knownDependencyIds: this.satisfiedDependencyIds(),
    });
    if (err) return { ok: false, error: err.message };
    for (const task of tasks) {
      const pathError = validateWorkspaceWritePaths(
        this.opts.cwd,
        task.authorityRequest.writePaths,
      );
      if (pathError) {
        return { ok: false, error: `task ${task.id}: ${pathError}` };
      }
    }
    for (const task of tasks) {
      this.registerHandle({
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        deps: task.deps ?? [],
        specialty: inferSpecialty(`${task.title} ${task.prompt}`),
        executorBackendId: task.executorBackendId,
        writePaths: task.writePaths,
        executionProfile: task.executionProfile,
        contextSelection: task.contextSelection,
        workspaceMode: task.workspaceMode,
        authorityRequest: task.authorityRequest,
        dependencyGate: task.dependencyGate,
        budget: task.budget,
        approvalDecisionId: approval?.decisionId,
        approvalRecordedAt: approval?.approvedAt,
        approvedPlanVersion: this.planVersion + 1,
        acceptanceCriteria: task.acceptanceCriteria,
      });
    }
    this.planVersion += 1;
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { ok: true };
  }

  async revisePlan(
    expectedPlanVersion: number,
    operations: PlanRevisionOperation[],
  ): Promise<{ ok: true; planVersion: number } | { ok: false; error: string }> {
    if (expectedPlanVersion !== this.planVersion) {
      return {
        ok: false,
        error: `stale plan version: expected ${expectedPlanVersion}, current ${this.planVersion}`,
      };
    }

    const projected = new Map<string, PlanMeetingTask>();
    for (const handle of this.workers.values()) {
      const normalized = normalizePlanMeetingTasks([{
        id: handle.id,
        title: handle.title,
        prompt: handle.prompt,
        deps: [...handle.deps],
        executorBackendId: handle.executorBackendId,
        writePaths: handle.writePaths ? [...handle.writePaths] : undefined,
        executionProfile: handle.executionProfile ? structuredClone(handle.executionProfile) : undefined,
        contextSelection: handle.contextSelection ? structuredClone(handle.contextSelection) : undefined,
        workspaceMode: handle.workspaceMode,
        authorityRequest: handle.authorityRequest ? structuredClone(handle.authorityRequest) : undefined,
        dependencyGate: handle.dependencyGate,
        budget: structuredClone(handle.budget),
        acceptanceCriteria: handle.acceptanceCriteria
          ? structuredClone(handle.acceptanceCriteria)
          : undefined,
      }], this.opts.defaultBackendId ?? 'claude-code').tasks[0];
      projected.set(handle.id, normalized);
    }

    for (const operation of operations) {
      if (operation.kind === 'add-task') {
        if (this.opts.taskAuthorityCompilerRequired) {
          return {
            ok: false,
            error: 'adding a task requires a new user-approved plan version',
          };
        }
        if (projected.has(operation.task.id)) {
          return { ok: false, error: `Worker id already in use: ${operation.task.id}` };
        }
        projected.set(operation.task.id, {
          ...operation.task,
          deps: [...(operation.task.deps ?? [])],
        });
        continue;
      }

      const handle = this.workers.get(operation.taskId);
      if (!handle) return { ok: false, error: this.unknownTaskError(operation.taskId) };
      if (operation.kind === 'cancel-pending-task') {
        if (!projected.has(operation.taskId)) {
          return { ok: false, error: `task ${operation.taskId} is cancelled more than once` };
        }
        if (handle.status !== 'pending' || handle.session) {
          return {
            ok: false,
            error: `task ${operation.taskId} cannot be cancelled while ${handle.status}`,
          };
        }
        projected.delete(operation.taskId);
        continue;
      }
      if (operation.kind === 'update-task') {
        const task = projected.get(operation.taskId);
        if (!task) return { ok: false, error: this.unknownTaskError(operation.taskId) };
        if (handle.status !== 'pending' || handle.session) {
          return {
            ok: false,
            error: 'running task execution boundaries require a new attempt',
          };
        }
        if (
          this.opts.taskAuthorityCompilerRequired
          && operation.authorityRequest !== undefined
          && JSON.stringify(operation.authorityRequest) !== JSON.stringify(handle.authorityRequest)
        ) {
          return {
            ok: false,
            error: 'changing task authority requires a new user-approved plan version',
          };
        }
        if (
          this.opts.taskAuthorityCompilerRequired
          && operation.workspaceMode !== undefined
          && operation.workspaceMode !== handle.workspaceMode
        ) {
          return {
            ok: false,
            error: 'changing workspace mode requires a new user-approved plan version',
          };
        }
        projected.set(operation.taskId, {
          ...task,
          ...(operation.deps !== undefined ? { deps: [...operation.deps] } : {}),
          ...(operation.executionProfile !== undefined
            ? {
                executionProfile: structuredClone(operation.executionProfile),
                executorBackendId: operation.executionProfile.backendId,
              }
            : {}),
          ...(operation.contextSelection !== undefined
            ? { contextSelection: structuredClone(operation.contextSelection) }
            : {}),
          ...(operation.workspaceMode !== undefined ? { workspaceMode: operation.workspaceMode } : {}),
          ...(operation.authorityRequest !== undefined
            ? {
                authorityRequest: structuredClone(operation.authorityRequest),
                writePaths: [...operation.authorityRequest.writePaths],
              }
            : {}),
          ...(operation.budget !== undefined
            ? { budget: structuredClone(operation.budget) }
            : {}),
        });
        continue;
      }
      if (handle.status !== 'running' || !handle.session) {
        return {
          ok: false,
          error: `task ${operation.taskId} cannot be steered while ${handle.status}`,
        };
      }
      if (!this.opts.taskMailbox) {
        return { ok: false, error: 'durable task mailbox is unavailable' };
      }
    }

    const graphError = validatePlan(Array.from(projected.values()));
    if (graphError) return { ok: false, error: graphError.message };
    for (const task of projected.values()) {
      const writePaths = task.authorityRequest?.writePaths ?? task.writePaths ?? [];
      const pathError = validateWorkspaceWritePaths(this.opts.cwd, writePaths);
      if (pathError) {
        return { ok: false, error: `task ${task.id}: ${pathError}` };
      }
    }

    // Steering is the only operation with an asynchronous durable boundary.
    // Complete it before mutating the in-memory graph so a mailbox failure
    // cannot leave an add/cancel/update revision half-applied.
    for (const operation of operations) {
      if (operation.kind !== 'steer-running-task') continue;
      let result: SteerResult;
      try {
        result = await this.steerTask(operation.taskId, operation.addendum);
      } catch (error) {
        return {
          ok: false,
          error: `validated steer failed for ${operation.taskId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          error: `validated steer failed for ${operation.taskId}: ${result.reason}`,
        };
      }
    }

    for (const operation of operations) {
      if (operation.kind === 'add-task') {
        this.registerHandle({
          id: operation.task.id,
          title: operation.task.title,
          prompt: operation.task.prompt,
          deps: operation.task.deps ?? [],
          specialty: inferSpecialty(`${operation.task.title} ${operation.task.prompt}`),
          executorBackendId: operation.task.executorBackendId,
          writePaths: operation.task.writePaths,
          executionProfile: operation.task.executionProfile,
          contextSelection: operation.task.contextSelection,
          workspaceMode: operation.task.workspaceMode,
          authorityRequest: operation.task.authorityRequest,
          dependencyGate: operation.task.dependencyGate,
          budget: operation.task.budget,
          acceptanceCriteria: operation.task.acceptanceCriteria,
        });
      } else if (operation.kind === 'cancel-pending-task') {
        const handle = this.workers.get(operation.taskId)!;
        if (handle.flushTimer) clearTimeout(handle.flushTimer);
        this.workers.delete(operation.taskId);
      } else if (operation.kind !== 'steer-running-task') {
        const handle = this.workers.get(operation.taskId)!;
        if (operation.deps !== undefined) handle.deps = [...operation.deps];
        if (operation.executionProfile !== undefined) {
          handle.executionProfile = structuredClone(operation.executionProfile);
          handle.executorBackendId = operation.executionProfile.backendId;
          handle.backendId = operation.executionProfile.backendId;
        }
        if (operation.contextSelection !== undefined) {
          handle.contextSelection = structuredClone(operation.contextSelection);
        }
        if (operation.workspaceMode !== undefined) handle.workspaceMode = operation.workspaceMode;
        if (operation.workspaceMode !== undefined) handle.workspaceDiagnostic = undefined;
        if (operation.authorityRequest !== undefined) {
          handle.authorityRequest = structuredClone(operation.authorityRequest);
          handle.writePaths = [...operation.authorityRequest.writePaths];
        }
        if (operation.budget !== undefined) {
          handle.budget = structuredClone(operation.budget);
        }
      }
    }

    this.planVersion += 1;
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { ok: true, planVersion: this.planVersion };
  }

  async queueFollowUp(taskId: string, text: string): Promise<TaskMessage> {
    const handle = this.workers.get(taskId);
    if (!handle) throw new Error(this.unknownTaskError(taskId));
    if (handle.status === 'budget-paused') {
      throw new Error('task rework is budget-paused and requires an explicit user budget decision');
    }
    const normalized = boundedTaskText(text, 'follow-up message');
    const freshAttempt = this.requiresFreshAttempt(handle.status);
    const message = await this.requireTaskMailbox().enqueue({
      taskId: handle.id,
      attempt: freshAttempt ? handle.attempt + 1 : handle.attempt,
      sender: 'coordinator',
      kind: 'follow-up',
      payload: { text: normalized },
    });
    if (freshAttempt) this.beginFollowUpAttempt(handle);
    // A follow-up never interrupts a turn. Pending/running messages are
    // delivered one-at-a-time from a provider result boundary.
    if (handle.status === 'pending') this.spawnReadyWorkers();
    return message;
  }

  async sendTaskMessage(taskId: string, text: string): Promise<TaskMessage> {
    const handle = this.workers.get(taskId);
    if (!handle) throw new Error(this.unknownTaskError(taskId));
    if (handle.status === 'budget-paused') {
      throw new Error('task rework is budget-paused and requires an explicit user budget decision');
    }
    const normalized = boundedTaskText(text, 'task message');
    const freshAttempt = this.requiresFreshAttempt(handle.status);
    const message = await this.requireTaskMailbox().enqueue({
      taskId: handle.id,
      attempt: freshAttempt ? handle.attempt + 1 : handle.attempt,
      sender: 'coordinator',
      kind: 'instruction',
      payload: { text: normalized },
    });
    if (freshAttempt) this.beginFollowUpAttempt(handle);
    if (handle.status === 'pending') this.spawnReadyWorkers();
    return message;
  }

  async steerTask(taskId: string, text: string): Promise<SteerResult> {
    const handle = this.workers.get(taskId);
    if (!handle) {
      return { ok: false, reason: 'unknown', availableTaskIds: this.listKnownTaskIds() };
    }
    if (handle.status === 'done' || handle.status === 'accepted') return { ok: false, reason: 'done' };
    if (handle.status === 'failed') return { ok: false, reason: 'failed' };
    if (!handle.session) return { ok: false, reason: 'no-session' };
    let normalized: string;
    try {
      normalized = boundedTaskText(text, 'steering message');
    } catch {
      return { ok: false, reason: 'invalid-message' };
    }
    const mailbox = this.requireTaskMailbox();
    const message = await mailbox.enqueue({
      taskId: handle.id,
      attempt: handle.attempt,
      sender: 'coordinator',
      kind: 'steer',
      payload: { text: normalized },
    });
    if (handle.pendingDelegateAck) return { ok: true, queued: true };
    const session = handle.session;
    this.steeringMessageByWorker.set(handle.id, message.id);
    try {
      await session.interrupt('steer');
      if (handle.session !== session || handle.status !== 'running') {
        this.steeringMessageByWorker.delete(handle.id);
        await mailbox.markFailed(handle.id, message.id);
        return { ok: true, queued: true };
      }
      session.sendUserText(`(plan update) ${normalized}`);
      await mailbox.markDelivered(handle.id, message.id);
      this.pendingMailboxAckByWorker.set(handle.id, message.id);
    } catch (error) {
      this.steeringMessageByWorker.delete(handle.id);
      await mailbox.markFailed(handle.id, message.id).catch(() => undefined);
      console.error(`[scheduler] steerTask delivery failed for ${taskId}:`, error);
      return { ok: true, queued: true };
    }
    handle.live.busy = true;
    handle.live.lastUpdateTs = Date.now();
    handle.stallNotified = false;
    handle.stallNudged = false;
    return { ok: true, queued: false };
  }

  /** Legacy name retained for renderer/MCP compatibility. Success means the
   * instruction is durably queued, never that the Backend acknowledged it. */
  steerWorker(workerId: string, addendum: string): Promise<SteerResult> {
    return this.steerTask(workerId, addendum);
  }

  async recordWorkerQuestion(
    taskId: string,
    question: string,
    sourceAttempt?: number,
  ): Promise<TaskMessage> {
    const handle = this.workers.get(taskId);
    if (!handle) throw new Error(this.unknownTaskError(taskId));
    if (handle.status !== 'running' || !handle.session) {
      throw new Error(`worker cannot ask a question while ${handle.status}`);
    }
    if (sourceAttempt !== undefined && sourceAttempt !== handle.attempt) {
      throw new Error(
        `stale worker attempt ${sourceAttempt}; current attempt is ${handle.attempt}`,
      );
    }
    const normalized = boundedTaskText(question, 'worker question');
    const mailbox = this.requireTaskMailbox();
    const message = await mailbox.enqueue({
      taskId: handle.id,
      attempt: handle.attempt,
      sender: 'worker',
      kind: 'question',
      payload: { text: normalized },
    });
    const coordinator = this.talkerProvider();
    if (!coordinator) return message;
    try {
      coordinator.sendUserText(
        `(task question from ${handle.id}, message ${message.id}) ${normalized}`,
        'high',
      );
      await mailbox.markDelivered(handle.id, message.id);
    } catch {
      await mailbox.markFailed(handle.id, message.id);
    }
    return mailbox.get(handle.id, message.id) ?? message;
  }

  /** Re-deliver Worker questions that were queued while the Coordinator host
   *  was unavailable. recordWorkerQuestion enqueues durably but only delivers
   *  when a Coordinator session exists; if it was null at ask time the question
   *  stayed 'queued' forever (only follow-up/instruction/steer are re-driven on
   *  activity). Called from the orchestrator after a Coordinator (re)start. */
  async redeliverPendingWorkerQuestions(): Promise<void> {
    const mailbox = this.opts.taskMailbox;
    if (!mailbox) return;
    const coordinator = this.talkerProvider();
    if (!coordinator) return;
    for (const handle of this.workers.values()) {
      if (handle.status !== 'running' || !handle.session) continue;
      const questions = mailbox.list(handle.id).filter((message) => (
        message.sender === 'worker'
        && message.kind === 'question'
        && message.status === 'queued'
        && message.attempt === handle.attempt
      ));
      for (const message of questions) {
        let text: string;
        try {
          text = this.messageText(message);
        } catch {
          continue;
        }
        try {
          coordinator.sendUserText(
            `(task question from ${handle.id}, message ${message.id}) ${text}`,
            'high',
          );
          await mailbox.markDelivered(handle.id, message.id);
        } catch {
          await mailbox.markFailed(handle.id, message.id).catch(() => undefined);
        }
      }
    }
  }

  async forwardTaskMessage(
    fromTaskId: string,
    toTaskId: string,
    messageId: string,
  ): Promise<TaskMessage> {
    const mailbox = this.requireTaskMailbox();
    const source = mailbox.get(fromTaskId, messageId);
    if (!source || source.sender !== 'worker' || source.kind !== 'question') {
      throw new Error('forward source must be a durable Worker question');
    }
    if (source.status !== 'delivered' && source.status !== 'acknowledged') {
      throw new Error('forward source must have reached the Coordinator');
    }
    const target = this.workers.get(toTaskId);
    if (!target) throw new Error(this.unknownTaskError(toTaskId));
    if (target.status === 'budget-paused') {
      throw new Error('target task is budget-paused and requires an explicit user budget decision');
    }
    const text = this.messageText(source);
    const freshAttempt = this.requiresFreshAttempt(target.status);
    const forwarded = await mailbox.enqueue({
      taskId: target.id,
      attempt: freshAttempt ? target.attempt + 1 : target.attempt,
      sender: 'coordinator',
      kind: 'follow-up',
      replyTo: source.id,
      payload: {
        text,
        forwardedFromTaskId: fromTaskId,
      },
    });
    if (freshAttempt) this.beginFollowUpAttempt(target);
    if (source.status === 'delivered') {
      await mailbox.acknowledge(fromTaskId, source.id);
    }
    return forwarded;
  }

  markTaskDone(workerId: string, summary: string): void {
    const handle = this.workers.get(workerId);
    if (!handle) {
      console.warn('[scheduler] task_done from unknown worker', {
        workerId,
        summary: summary.slice(0, 200),
      });
      return;
    }
    handle.summary = summary;
    this.talkerProvider()?.sendUserText(
      `(worker ${workerId} sent a legacy task_done summary; a complete WorkReport is still required before verification.)`,
      'low',
    );
  }

  submitWorkerReport(workerId: string, report: WorkReport): void {
    const handle = this.workers.get(workerId);
    if (!handle) {
      console.warn('[scheduler] WorkReport from unknown worker', { workerId });
      return;
    }
    void this.handleWorkerSignal(handle, { kind: 'delivery', report });
  }

  submitWorkerDelivery(workerId: string, files: string[]): void {
    const handle = this.workers.get(workerId);
    if (!handle) {
      console.warn('[scheduler] submit_delivery from unknown worker', { workerId, files });
      return;
    }
    // De-duplicate while preserving order. Workers may call submit_delivery
    // more than once (e.g. after generating additional artifacts) — later
    // calls append rather than replace so the final set is the union.
    const seen = new Set(handle.explicitDeliveries);
    for (const f of files) {
      if (!seen.has(f)) {
        handle.explicitDeliveries.push(f);
        seen.add(f);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** Tear down every live worker resource and stamp terminal status onto
   *  each handle. Pending or running workers at end-of-session count as
   *  failed (the user pulled the plug before task_done landed); done/failed
   *  workers keep their status. Idempotent via `disposeWorker`. */
  endAll(): void {
    this.stopStallWatch();
    for (const handle of this.workers.values()) {
      const finalStatus: WorkerStatusKind =
        handle.status === 'running' || handle.status === 'pending'
          ? 'failed'
          : handle.status;
      this.disposeWorker(handle, finalStatus, handle.summary);
    }
    this.workers.clear();
  }

  // ---------------------------------------------------------------------------
  // B1 stall watchdog. Armed lazily when a worker spawns, stops itself once no
  // worker is 'running'. Emits one `worker-stalled` per idle stretch so a hung
  // worker (no SDK events at all) still surfaces a spoken signal to the user.

  private startStallWatch(): void {
    if (this.stallTimer) return;
    this.stallTimer = setInterval(() => this.sweepStalls(), STALL_SWEEP_MS);
    // Allow process exit even if the timer is still armed (e.g. graceful
    // shutdown skipped endAll()). Without unref, this timer keeps the event
    // loop alive indefinitely.
    this.stallTimer.unref();
  }

  private stopStallWatch(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private sweepStalls(): void {
    if (this.opts.isClosed()) {
      this.stopStallWatch();
      return;
    }
    const now = Date.now();
    let anyActive = false;
    for (const handle of this.workers.values()) {
      if (handle.status === 'running' && handle.session) {
        anyActive = true;
        if (handle.stallNotified) continue;
        const idleMs = now - handle.live.lastUpdateTs;
        if (idleMs < STALL_THRESHOLD_MS) continue;

        if (!handle.stallNudged) {
          // First stall: nudge the worker to continue rather than bothering
          // the user. The nudge resets stallNotified so the next sweep cycle
          // re-checks; if it's still stuck we escalate.
          handle.stallNudged = true;
          const toolHint = handle.live.currentTool
            ? `你当前卡在 ${handle.live.currentTool}，`
            : '';
          handle.session.sendUserText(
            `${toolHint}已经超过 ${Math.round(idleMs / 1000)} 秒没有进展了。请继续执行你的任务，如果遇到无法解决的问题就直接换一个方案绕过去。不要停下来等确认。`,
            'normal',
          );
          continue;
        }

        // Second stall (nudge didn't help): escalate to the user.
        handle.stallNotified = true;
        this.opts.emit({
          source: 'talker',
          event: {
            kind: 'worker-stalled',
            workerId: handle.id,
            title: handle.title,
            idleMs,
            currentTool: handle.live.currentTool,
          },
        });
        this.emitCoordinatorBriefing({
          kind: 'stalled',
          title: `${handle.title} 长时间无进展`,
          summary: handle.live.currentTool
            ? `Worker 停留在 ${handle.live.currentTool}，自动提醒后仍未继续。`
            : 'Worker 在自动提醒后仍未产生新进展。',
          blockers: [handle.live.currentTool ?? 'no-progress'],
          recommendedAction: 'request-user-decision',
          workerId: handle.id,
          taskId: handle.currentTaskId,
        });
      } else if (PARKED_SLOT_STATUSES.has(handle.status)) {
        // Parked slot-holders (verifying / awaiting-acceptance / integrating /
        // ...) hold a concurrency slot but emit no SDK activity, so the running
        // sweep above never touches them. Surface long-stuck parkers and
        // fail-close the should-be-transient ones.
        anyActive = true;
        this.sweepParked(handle, now);
      }
    }
    if (!anyActive) this.stopStallWatch();
  }

  /** Alert (and for transient parks, fail-closed) a worker parked in a
   *  slot-holding delivery status for too long. Externally-waiting states
   *  (awaiting-acceptance / integration-conflict / coordinator-reviewing) only
   *  get a briefing - they legitimately wait on a human. Transient states
   *  (verifying / integrating) that never resolve are fail-closed. */
  private sweepParked(handle: WorkerHandle, now: number): void {
    const since = handle.parkedSinceTs ?? handle.live.lastUpdateTs;
    const parkedMs = now - since;
    if (parkedMs < PARKED_ALERT_MS) return;
    if (PARKED_TRANSIENT_STATUSES.has(handle.status) && parkedMs >= PARKED_FAIL_CLOSED_MS) {
      // A transient park should resolve in seconds. If it hasn't in
      // PARKED_FAIL_CLOSED_MS the harness is hung on an await that will never
      // settle - fail the attempt closed and free the slot.
      const summary = `Worker 在 ${handle.status} 状态超过 ${Math.round(parkedMs / 1000)} 秒未恢复，已自动失败。`;
      this.opts.emit({
        source: 'talker',
        event: { kind: 'worker-ended', workerId: handle.id, status: 'failed', summary },
      });
      this.emitCoordinatorBriefing({
        kind: 'failed',
        title: `${handle.title} 交付卡死`,
        summary,
        blockers: [handle.status],
        recommendedAction: 'rework',
        workerId: handle.id,
        taskId: handle.currentTaskId,
      });
      this.harvestUnresolvedAddenda(handle);
      this.disposeWorker(handle, 'failed', summary);
      this.emitPlanUpdate();
      this.cascadeFailure(handle.id);
      this.spawnReadyWorkers();
      return;
    }
    if (handle.parkedNotified) return;
    handle.parkedNotified = true;
    const action: CoordinatorBriefing['recommendedAction'] =
      handle.status === 'awaiting-acceptance' ? 'review'
        : handle.status === 'integration-conflict' ? 'rework'
        : 'request-user-decision';
    this.emitCoordinatorBriefing({
      kind: 'stalled',
      title: `${handle.title} 停留在 ${handle.status}`,
      summary: `Worker 已在 ${handle.status} 状态等待 ${Math.round(parkedMs / 1000)} 秒，占用一个并发槽位。`,
      blockers: [handle.status],
      recommendedAction: action,
      workerId: handle.id,
      taskId: handle.currentTaskId,
    });
  }

  // ---------------------------------------------------------------------------
  // Session event handler — wired into every spawnWorker emit callback.

  onWorkerEvent(
    workerId: string,
    e: BackendSessionEvent,
    sourceAttempt?: number,
  ): void {
    const handle = this.workers.get(workerId);
    if (!handle) return;

    try {
      if (e.kind === 'worker-signal') {
        void this.handleWorkerSignal(handle, e.signal);
      } else if (e.kind === 'message') {
        // Any SDK message is progress: bump the activity clock and clear the
        // stall flag so the watchdog re-arms for the next idle stretch.
        handle.live.lastUpdateTs = Date.now();
        handle.stallNotified = false;
        handle.stallNudged = false;
        // SDK message shapes are opaque; we walk known fields defensively.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const msg: any = e.message;
        if (msg?.type === 'assistant') {
          void this.acknowledgeMailboxDelivery(handle);
          if (handle.pendingDelegateAck) {
            handle.pendingDelegateAck = false;
            void this.deliverQueuedSteer(handle);
          }
          const text = extractText(msg);
          if (text) {
            handle.live.lastAssistantText = text;
            handle.live.lastUpdateTs = Date.now();
            this.queueWorkerUpdate(handle, `[${handle.id}] thought: ${condense(text, ASSISTANT_CONDENSE_CHARS)}`);
          }
          const tools = extractToolUses(msg);
          if (tools.length > 0) {
            const t = tools[tools.length - 1];
            handle.live.currentTool = t.name;
            handle.live.currentToolInput = summariseToolInput(t.name, t.input);
            handle.live.busy = true;
            this.queueWorkerUpdate(
              handle,
              `[${handle.id}] started ${t.name}${handle.live.currentToolInput ? `: ${handle.live.currentToolInput}` : ''}`,
            );
            // Track file edits for collision advisory + delivery snapshot.
            // recordFileEdit drives the cross-worker collision warning; the
            // handle.deliveries Set is the per-task list that markTaskDone
            // snapshots into a `worker-delivery` event for the renderer
            // ScreenStage acceptance panel.
            for (const t2 of tools) {
              if (FILE_EDIT_TOOLS.has(t2.name)) {
                const p = extractFilePath(t2.input);
                if (p) {
                  this.recordFileEdit(workerId, p);
                  handle.deliveries.add(p);
                }
              }
            }
          }
        } else if (msg?.type === 'user') {
          try {
            const content = msg?.message?.content;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hasResult = Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result');
            if (hasResult && handle.live.currentTool) {
              this.queueWorkerUpdate(handle, `[${handle.id}] finished ${handle.live.currentTool}`);
              handle.live.currentTool = null;
              handle.live.currentToolInput = null;
            }
          } catch (err) {
            // SDK shape drift would silently leak tool-result clearing here.
            // Warn so we notice rather than ship a half-broken status line.
            console.warn('[worker-scheduler] tool_result parse failed', { workerId: handle.id, err });
          }
        } else if (msg?.type === 'result') {
          handle.live.busy = false;
          // A provider turn boundary never completes a task. Only a validated
          // WorkReport can enter DeliveryHarness; this note merely keeps the
          // Coordinator informed.
          this.queueWorkerUpdate(handle, `[${handle.id}] turn complete`);
          void this.acknowledgeMailboxDelivery(handle)
            .then(() => this.deliverNextFollowUp(handle));
        }
      } else if (e.kind === 'auth-required') {
        void this.handleWorkerSignal(handle, {
          kind: 'failed',
          code: 'auth-required',
          message: e.error,
          retryable: false,
        });
      } else if (e.kind === 'permission-request') {
        if (sourceAttempt !== undefined && sourceAttempt !== handle.attempt) {
          handle.session?.resolvePermission(e.id, 'deny', 'stale task attempt');
          return;
        }
        void this.handlePermissionRequest(handle, e);
      } else if (e.kind === 'permission-cancelled') {
        this.opts.emit({ source: workerId, event: e });
      } else if (e.kind === 'error') {
        void this.handleWorkerSignal(handle, {
          kind: 'failed',
          code: 'worker-runtime-error',
          message: e.error,
          retryable: true,
        });
      } else if (e.kind === 'ended') {
        // Intentional park: we already nullled session and kept a delivery
        // status. Ignore the adapter's follow-on ended so parked workers are
        // not reclassified as crashes.
        if (PARKED_SLOT_STATUSES.has(handle.status) && !handle.session) {
          this.steeringMessageByWorker.delete(handle.id);
          return;
        }
        // A BackendSession `ended` is a real session end, not a steer
        // interrupt: steer interrupts (`session.interrupt('steer')`) emit a
        // `worker-signal { kind: 'ended', reason: 'interrupted' }` that is
        // handled in handleWorkerSignal with a reason check. Swallowing a real
        // `ended` here just because a steer was in flight turned crashes into
        // permanent `running` zombies (the stall watchdog only alerts).
        // The session is gone, so any in-flight steer is void - clear it so it
        // can't stick and block deliverQueuedSteer / deliverNextFollowUp.
        this.steeringMessageByWorker.delete(handle.id);
        // SDK stream end is transport state, never delivery success. A report
        // already being verified is allowed to finish; an unreported running
        // Worker is failed closed by handleWorkerSignal.
        if (handle.status === 'running' || handle.report) {
          void this.handleWorkerSignal(handle, { kind: 'ended', reason: 'crashed' });
        } else {
          // Defensive re-dispose in case the session leaked back here after a
          // direct end() — disposeWorker is idempotent.
          this.disposeWorker(handle, handle.status, handle.summary);
        }
      }
    } catch (err) {
      console.error(`[scheduler] onWorkerEvent body threw for ${workerId}:`, err);
      if (e.kind === 'ended' && handle.status === 'running') {
        try {
          this.harvestUnresolvedAddenda(handle);
          this.disposeWorker(handle, 'failed');
          this.emitPlanUpdate();
          this.cascadeFailure(workerId);
        } catch (cleanupErr) {
          console.error(`[scheduler] cleanup after ended-handler throw also failed for ${workerId}:`, cleanupErr);
        }
      }
    }
  }

  private async handlePermissionRequest(
    handle: WorkerHandle,
    event: Extract<BackendSessionEvent, { kind: 'permission-request' }>,
  ): Promise<void> {
    const fallback: PermissionNormalizationResult = {
      ok: false,
      diagnostic: 'unsupported-native-tool',
      requiresUser: true,
    };
    let normalized: PermissionNormalizationResult = fallback;
    try {
      normalized = this.opts.normalizePermissionRequest?.(handle.backendId, {
        taskId: handle.id,
        attempt: handle.attempt,
        backendId: handle.backendId,
        workspaceRoot: handle.workspace?.cwd ?? this.opts.cwd,
        nativeRequestId: event.id,
        toolName: event.toolName,
        input: event.input,
      }) ?? fallback;
    } catch {
      normalized = {
        ok: false,
        diagnostic: 'invalid-native-request',
        requiresUser: true,
      };
    }
    const canonical = decideTaskPermission(
      normalized,
      handle.authorityGrant,
      Date.now(),
      {
        backendId: handle.backendId,
        taskId: handle.id,
        attempt: handle.attempt,
        nativeRequestId: event.id,
        toolName: event.toolName,
      },
      handle.authorityAddendum,
    );
    const persist = this.opts.persistPermissionDecision;
    if (!persist && this.opts.taskAuthorityCompilerRequired) {
      handle.session?.resolvePermission(event.id, 'deny', 'permission journal unavailable');
      return;
    }
    try {
      await persist?.({
        taskId: handle.id,
        attempt: handle.attempt,
        nativeRequestId: event.id,
        decision: canonical.decision.kind,
        reason: canonical.decision.reason,
        safeInput: canonical.safeInput,
        grantHash: handle.authorityGrant?.grantHash,
      });
    } catch {
      handle.session?.resolvePermission(event.id, 'deny', 'permission journal write failed');
      return;
    }
    if (canonical.decision.kind === 'allow') {
      handle.authorityDenyStreak = 0;
      handle.lastAuthorityDenyReason = undefined;
      handle.session?.resolvePermission(event.id, 'allow', canonical.decision.reason);
      return;
    }
    if (canonical.decision.kind === 'deny') {
      const reason = canonical.decision.reason;
      if (handle.lastAuthorityDenyReason === reason) {
        handle.authorityDenyStreak += 1;
      } else {
        handle.lastAuthorityDenyReason = reason;
        handle.authorityDenyStreak = 1;
      }
      handle.session?.resolvePermission(event.id, 'deny', reason);
      if (
        handle.authorityDenyStreak >= AUTHORITY_DENY_STREAK_LIMIT
        && handle.status === 'running'
      ) {
        this.failAuthorityExhaustion(handle, reason);
      }
      return;
    }
    handle.authorityDenyStreak = 0;
    handle.lastAuthorityDenyReason = undefined;
    // Remember what this card is actually asking for: if the user allows it,
    // the same target should not interrupt them again this attempt.
    if (
      normalized.ok
      && handle.authorityGrant
      && canonical.decision.reason.startsWith('authority-miss:')
    ) {
      const pending = handle.pendingAuthorityAsks ?? new Map();
      if (pending.size < PENDING_AUTHORITY_ASK_MAX) {
        pending.set(event.id, normalized.request);
        handle.pendingAuthorityAsks = pending;
      }
    }
    this.opts.emit({
      source: handle.id,
      event: {
        ...event,
        input: canonical.safeInput,
      },
    });
    // Fail-closed backstop: an unanswered ask-user card would otherwise hang
    // the SDK's canUseTool forever (the stall watchdog alerts but cannot
    // resolve it). Mirror PermissionBroker's timeout. OpenCode is excluded -
    // its adapter owns the broker which already arms this timer.
    if (handle.backendId !== 'opencode') {
      this.armPermissionTimeout(handle, event.id);
    }
  }

  /** Arm a fail-closed deny timer for an ask-user permission request. On fire
   *  the SDK permission is denied and the meeting-UI card is withdrawn. */
  private armPermissionTimeout(handle: WorkerHandle, requestId: string): void {
    this.clearPermissionTimeout(requestId);
    const entry = {
      handleId: handle.id,
      timer: setTimeout(() => {
        this.permissionTimers.delete(requestId);
        if (this.opts.isClosed()) return;
        const target = this.workers.get(handle.id);
        if (!target || !target.session) return;
        if (
          target.status === 'failed'
          || target.status === 'accepted'
          || target.status === 'interrupted'
          || target.status === 'done'
        ) {
          return;
        }
        target.session.resolvePermission(requestId, 'deny', 'permission-timeout');
        this.opts.emit({ source: handle.id, event: { kind: 'permission-cancelled', id: requestId } });
        this.emitCoordinatorBriefing({
          kind: 'stalled',
          title: `${target.title} 权限请求超时`,
          summary: `权限请求 ${Math.round(DEFAULT_PERMISSION_TIMEOUT_MS / 1000)}s 未响应，已自动拒绝。`,
          blockers: ['permission-timeout'],
          recommendedAction: 'request-user-decision',
          workerId: target.id,
          taskId: target.currentTaskId,
        });
      }, DEFAULT_PERMISSION_TIMEOUT_MS),
    };
    entry.timer.unref?.();
    this.permissionTimers.set(requestId, entry);
  }

  private clearPermissionTimeout(requestId: string): void {
    const entry = this.permissionTimers.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.permissionTimers.delete(requestId);
  }

  /** Drop every fail-closed timer owned by a handle - used on dispose and on
   *  rework attempt boundaries (beginFollowUpAttempt ends the session without
   *  going through disposeWorker, so a stale timer would otherwise fire on the
   *  reused handle's next session). */
  private clearPermissionTimersForHandle(handleId: string): void {
    for (const [requestId, entry] of this.permissionTimers) {
      if (entry.handleId === handleId) {
        clearTimeout(entry.timer);
        this.permissionTimers.delete(requestId);
      }
    }
  }

  private failAuthorityExhaustion(handle: WorkerHandle, reason: string): void {
    const summary = `blocked by repeated authority denial: ${reason}`;
    console.error(`[scheduler] authority deny streak for ${handle.id}:`, reason);
    handle.summary = summary;
    this.opts.emit({
      source: 'talker',
      event: { kind: 'worker-ended', workerId: handle.id, status: 'failed', summary },
    });
    this.harvestUnresolvedAddenda(handle);
    this.disposeWorker(handle, 'failed', summary);
    this.emitPlanUpdate();
    this.cascadeFailure(handle.id);
    this.spawnReadyWorkers();
  }

  private createWorkerEvent(handle: WorkerHandle, signal: WorkerAdapterSignal): WorkerEvent {
    return {
      schemaVersion: 2,
      eventId: randomUUID(),
      seq: ++handle.eventSeq,
      timestamp: Date.now(),
      meetingId: this.opts.meetingId ?? 'meeting',
      taskId: handle.currentTaskId,
      attempt: handle.attempt,
      workerId: handle.id,
      backendId: handle.backendId,
      payload: signal,
    };
  }

  private async handleWorkerSignal(handle: WorkerHandle, value: WorkerAdapterSignal): Promise<void> {
    const parsed = parseWorkerAdapterSignal(value);
    if (!parsed.ok) {
      console.warn('[scheduler] rejected invalid Worker signal', {
        workerId: handle.id,
        error: parsed.error,
      });
      return;
    }
    const signal = parsed.signal;
    const reportProtocolFailure = signal.kind === 'failed'
      && (signal.code === 'invalid-work-report' || signal.code === 'missing-work-report');
    const canRequestReportCorrection = reportProtocolFailure
      && handle.status === 'running'
      && !this.hasWorkReportRecovery(handle);
    if (canRequestReportCorrection) {
      // Adapters emit the invalid-report failure and the provider's completed
      // turn boundary back-to-back. Claim that one paired completion before
      // awaiting journal I/O so it cannot race ahead and fail the task.
      handle.suppressNextReportlessCompletion = true;
    }
    const event = this.createWorkerEvent(handle, signal);
    this.opts.emit({ source: handle.id, event: { kind: 'worker-event', event } });
    const duplicateReport = signal.kind === 'delivery' && handle.report !== null;
    if (signal.kind === 'delivery' && !duplicateReport) {
      // Claim the report synchronously before any mailbox or steering await.
      // Providers commonly emit delivery and turn-ended back-to-back; without
      // this ordering, the terminal signal can race ahead and trigger a false
      // missing-report recovery.
      handle.report = signal.report;
      handle.summary = signal.report.summary;
    }
    if (signal.kind === 'progress' || signal.kind === 'tool' || signal.kind === 'delivery') {
      // Provider-neutral activity is also the authoritative acknowledgement
      // for message-less transports such as Codex app-server. A mailbox item
      // was already durable before send; the first subsequent Worker signal
      // proves that the new turn consumed it.
      await this.acknowledgeMailboxDelivery(handle);
    }
    if (
      handle.pendingDelegateAck
      && (signal.kind === 'progress' || signal.kind === 'tool' || signal.kind === 'delivery')
    ) {
      // Some Worker transports (notably Codex app-server) expose only the
      // canonical Worker signal stream and never emit a provider-native
      // assistant message. The first valid progress boundary proves that the
      // delegated prompt was consumed, so queued steering can be delivered.
      handle.pendingDelegateAck = false;
      await this.deliverQueuedSteer(handle);
    }

    handle.live.lastUpdateTs = Date.now();
    handle.stallNotified = false;
    handle.stallNudged = false;
    if (signal.kind === 'progress') {
      handle.live.lastAssistantText = signal.message;
      handle.live.busy = true;
      this.queueWorkerUpdate(handle, `[${handle.id}] ${condense(signal.message, ASSISTANT_CONDENSE_CHARS)}`);
      return;
    }
    if (signal.kind === 'tool') {
      handle.live.currentTool = signal.phase === 'started' ? signal.toolName : null;
      handle.live.currentToolInput = signal.detail ?? null;
      handle.live.busy = signal.phase === 'started';
      return;
    }
    if (signal.kind === 'failed') {
      if (canRequestReportCorrection) {
        const recoverySent = await this.requestMissingWorkReportRecovery(handle);
        if (recoverySent) return;
        handle.suppressNextReportlessCompletion = false;
      }
      handle.summary = signal.message;
      if (handle.status !== 'failed' && handle.status !== 'accepted') {
        handle.status = 'failed';
        this.opts.emit({
          source: 'talker',
          event: {
            kind: 'worker-ended',
            workerId: handle.id,
            status: 'failed',
            summary: signal.message,
          },
        });
        this.emitCoordinatorBriefing({
          kind: 'failed',
          title: `${handle.title} 执行失败`,
          summary: signal.message,
          blockers: [signal.code],
          recommendedAction: signal.retryable ? 'rework' : 'revise-plan',
          workerId: handle.id,
          taskId: handle.currentTaskId,
        });
        this.harvestUnresolvedAddenda(handle);
        this.disposeWorker(handle, 'failed', signal.message);
        this.emitPlanUpdate();
        this.cascadeFailure(handle.id);
        // Free the slot for independent queued workers - cascadeFailure only
        // fails dependents. Mirrors failAuthorityExhaustion / finalizeAcceptedHandle.
        this.spawnReadyWorkers();
      }
      return;
    }
    if (signal.kind === 'ended') {
      handle.live.busy = false;
      if (
        signal.reason === 'interrupted'
        && this.steeringMessageByWorker.has(handle.id)
      ) {
        // Steering interrupts one model turn, not the task lifecycle.
        handle.live.currentTool = null;
        handle.live.currentToolInput = null;
        return;
      }
      handle.transportEnded = true;
      if (
        signal.reason === 'completed'
        && !handle.report
        && handle.status === 'running'
        && handle.suppressNextReportlessCompletion
      ) {
        handle.suppressNextReportlessCompletion = false;
        handle.transportEnded = false;
        return;
      }
      if (
        signal.reason === 'completed'
        && !handle.report
        && handle.status === 'running'
      ) {
        const recoverySent = await this.requestMissingWorkReportRecovery(handle);
        if (!recoverySent) {
          await this.handleWorkerSignal(handle, {
            kind: 'failed',
            code: 'missing-work-report',
            message: 'Worker turn ended without a valid WorkReport after one protocol correction.',
            retryable: true,
          });
        }
      } else if (signal.reason === 'interrupted' && handle.status === 'running') {
        handle.status = 'interrupted';
        this.disposeWorker(handle, 'interrupted', 'Worker turn was interrupted.');
        this.emitPlanUpdate();
      } else if (
        signal.reason === 'crashed'
        && !handle.report
        && handle.status === 'running'
      ) {
        await this.handleWorkerSignal(handle, {
          kind: 'failed',
          code: 'worker-transport-ended',
          message: 'Worker transport ended before a valid WorkReport was delivered.',
          retryable: true,
        });
      }
      return;
    }
    if (duplicateReport) {
      console.warn('[scheduler] duplicate WorkReport ignored', {
        workerId: handle.id,
        taskId: handle.currentTaskId,
        attempt: handle.attempt,
      });
      return;
    }
    if (!handle.deliveryId || !this.opts.deliveryHarness) {
      handle.status = 'failed';
      this.opts.emit({
        source: 'talker',
        event: {
          kind: 'worker-ended',
          workerId: handle.id,
          status: 'failed',
          summary: 'DeliveryHarness is unavailable for this Worker.',
        },
      });
      this.emitPlanUpdate();
      return;
    }

    handle.status = 'verifying';
    // Delivery no longer needs the Backend session: free the concurrency slot
    // while verification / coordinator review / user acceptance run.
    this.releaseWorkerSession(handle);
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    let view: DeliveryView;
    try {
      view = await this.opts.deliveryHarness.submitExternalReport(handle.deliveryId, signal.report);
    } catch (error) {
      // submitExternalReport threw - most plausibly reviewDriver.request,
      // which evaluateReport does not wrap (delivery-harness). Without this
      // catch the worker sits in 'verifying' holding a slot forever - the
      // stall sweep only watches 'running'. Fail the attempt closed.
      await this.failDeliverySubmission(handle, error);
      return;
    }
    handle.attempt = view.attempt;
    this.applyDeliveryView(handle, view);
    if (view.status === 'reworking') {
      await this.scheduleAutomaticRework(handle, view);
      return;
    }
    if (view.status === 'failed' || view.status === 'cancelled') {
      // evaluateReport catches verifier / reviewer throws and transitions to
      // 'failed' (delivery-harness), returning the view here instead of
      // throwing. applyDeliveryView already stamped the status; dispose the
      // worker so it doesn't hold a slot as a zombie.
      await this.failDeliverySubmission(handle, new Error(`delivery ended in ${view.status} state`), view);
      return;
    }
    if (view.status === 'awaiting-delivery-acceptance') {
      this.recordSuccessfulBudgetAttempt(handle, view.attempt);
      await this.emitDeliveryCandidate(handle, view);
      const report = view.candidate?.report;
      this.emitCoordinatorBriefing({
        kind: 'delivery-ready',
        title: `${handle.title} 等待评审`,
        summary: report?.summary ?? handle.summary,
        files: report?.files.length ?? 0,
        testsPassed: report?.tests.filter((test) => test.status === 'passed').length ?? 0,
        testsFailed: report?.tests.filter((test) => test.status === 'failed').length ?? 0,
        blockers: report?.unresolved.filter((item) => item.blocking).map((item) => item.message) ?? [],
        recommendedAction: 'review',
        workerId: handle.id,
        taskId: handle.currentTaskId,
      });
    }
  }

  /** Fail a worker closed after its delivery submission threw or returned a
   *  terminal-failed view. Mirrors the `signal.kind === 'failed'` branch so
   *  dependents cascade and queued workers are spawned. */
  private async failDeliverySubmission(
    handle: WorkerHandle,
    error: unknown,
    view?: DeliveryView,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    const summary = view
      ? `delivery ${view.status}: ${view.error ?? detail}`
      : `delivery submission failed: ${detail}`;
    handle.summary = summary;
    this.opts.emit({
      source: 'talker',
      event: { kind: 'worker-ended', workerId: handle.id, status: 'failed', summary },
    });
    this.emitCoordinatorBriefing({
      kind: 'failed',
      title: `${handle.title} 交付失败`,
      summary,
      blockers: [detail],
      recommendedAction: 'rework',
      workerId: handle.id,
      taskId: handle.currentTaskId,
    });
    this.harvestUnresolvedAddenda(handle);
    this.disposeWorker(handle, 'failed', summary);
    this.emitPlanUpdate();
    this.cascadeFailure(handle.id);
    this.spawnReadyWorkers();
  }

  private applyDeliveryView(handle: WorkerHandle, view: DeliveryView): void {
    const mapped: Partial<Record<DeliveryView['status'], WorkerStatusKind>> = {
      executing: 'running',
      verifying: 'verifying',
      reviewing: 'reviewing',
      'coordinator-reviewing': 'coordinator-reviewing',
      'awaiting-delivery-acceptance': 'awaiting-acceptance',
      'integration-queued': 'integration-queued',
      integrating: 'integrating',
      'integration-conflict': 'integration-conflict',
      reworking: 'reworking',
      accepted: 'accepted',
      interrupted: 'interrupted',
      failed: 'failed',
      cancelled: 'failed',
    };
    const next = mapped[view.status];
    const prevStatus = handle.status;
    if (next && !(handle.status === 'budget-paused' && view.status === 'reworking')) {
      handle.status = next;
    }
    // Track when the handle entered its current parked (slot-holding) status so
    // sweepParked can alert / fail-closed long-stuck parkers. Reset on any
    // transition (including parked -> parked: that is progress, e.g.
    // integration-queued -> integrating) and clear once it leaves the park.
    if (next && PARKED_SLOT_STATUSES.has(next)) {
      if (prevStatus !== next || handle.parkedSinceTs === undefined) {
        handle.parkedSinceTs = Date.now();
        handle.parkedNotified = false;
      }
      // Parked delivery states never execute tools — drop the Backend session
      // so capacity is available for independent pending work.
      if (this.releaseWorkerSession(handle)) {
        this.spawnReadyWorkers();
      } else if (
        prevStatus !== handle.status
        && this.dependencyGateSatisfied(handle)
      ) {
        // Gate may have just opened for dependents even if session was already gone.
        this.spawnReadyWorkers();
      }
    } else if (handle.parkedSinceTs !== undefined) {
      handle.parkedSinceTs = undefined;
      handle.parkedNotified = false;
    }
    this.opts.emit({
      source: 'talker',
      event: {
        kind: 'delivery-status',
        workerId: handle.id,
        taskId: handle.currentTaskId,
        delivery: view,
      },
    });
    this.emitPlanUpdate();
  }

  private async emitDeliveryCandidate(handle: WorkerHandle, view: DeliveryView): Promise<void> {
    const report = view.candidate?.report;
    if (!report) return;
    if (handle.emittedCandidateId === view.candidate?.id) return;
    handle.emittedCandidateId = view.candidate?.id;
    const workerCwd = handle.workspace?.cwd ?? this.opts.cwd;
    const deliveredPaths = report.files
      .filter((file) => file.action !== 'deleted')
      .map((file) => file.path);
    const snapshotRoot = this.opts.deliveryArtifactRoot
      ?? pathResolve(workerCwd, 'deliveries');
    const snapshotMap = await snapshotDeliveryFiles(
      workerCwd,
      snapshotRoot,
      `${view.id}-attempt-${view.attempt}`,
      deliveredPaths,
    );
    this.opts.emit({
      source: 'talker',
      event: {
        kind: 'worker-delivery',
        workerId: handle.id,
        title: handle.title,
        summary: report.summary,
        taskId: handle.currentTaskId,
        deliveryId: view.id,
        files: deliveredPaths.map((path) => ({
          path,
          ...snapshotMap.get(path),
        })),
      },
    });
  }

  private async observeDelivery(handle: WorkerHandle, deliveryId: string): Promise<void> {
    if (!this.opts.deliveryHarness) return;
    try {
      for await (const _event of this.opts.deliveryHarness.observe(deliveryId)) {
        const view = await this.opts.deliveryHarness.inspect(deliveryId);
        this.applyDeliveryView(handle, view);
        if (
          view.candidate
          && ['integration-queued', 'integrating', 'accepted'].includes(view.status)
        ) {
          await this.emitDeliveryCandidate(handle, view);
        }
        if (view.status === 'accepted') {
          await this.finalizeAcceptedHandle(handle);
        }
      }
    } catch (error) {
      console.warn('[scheduler] delivery observer stopped', {
        workerId: handle.id,
        deliveryId,
        error: String(error),
      });
    }
  }

  async acceptDelivery(deliveryId: string, candidateId: string): Promise<DeliveryView> {
    if (!this.opts.deliveryHarness) throw new Error('DeliveryHarness is unavailable');
    const handle = Array.from(this.workers.values()).find((item) => item.deliveryId === deliveryId);
    if (!handle) throw new Error(`delivery worker not found: ${deliveryId}`);
    const view = await this.opts.deliveryHarness.decide(deliveryId, {
      kind: 'accept-delivery',
      candidateId,
    });
    this.applyDeliveryView(handle, view);
    await this.finalizeAcceptedHandle(handle);
    return view;
  }

  private async finalizeAcceptedHandle(handle: WorkerHandle): Promise<void> {
    if (handle.acceptedFinalized) return;
    handle.acceptedFinalized = true;
    // IntegrationQueue flushes its acceptance evidence before returning. Flush
    // the projected delivery event too, then and only then release DAG deps.
    try {
      await this.opts.flushEvents?.();
    } catch (error) {
      handle.acceptedFinalized = false;
      throw error;
    }
    const delivery = this.deliverySnapshotFor(handle);
    const reportOnly = delivery?.integration?.kind === 'report-only';
    this.disposeWorker(handle, 'accepted', handle.summary);
    this.opts.workspaceManager?.release(handle.id, false);
    this.opts.emit({
      source: 'talker',
      event: { kind: 'worker-ended', workerId: handle.id, status: 'accepted', summary: handle.summary },
    });
    this.emitCoordinatorBriefing({
      kind: 'accepted',
      title: reportOnly
        ? `${handle.title} 报告已确认（未进 Meeting 分支）`
        : `${handle.title} 已集成到 Meeting 分支`,
      summary: handle.summary || (
        reportOnly
          ? 'Report-only delivery accepted without Meeting-branch staging.'
          : 'Delivery integrated and accepted.'
      ),
      recommendedAction: 'continue',
      workerId: handle.id,
      taskId: handle.currentTaskId,
    });
    this.spawnReadyWorkers();
  }

  async returnDelivery(
    deliveryId: string,
    candidateId: string | undefined,
    feedback: string,
  ): Promise<DeliveryView> {
    if (!this.opts.deliveryHarness) throw new Error('DeliveryHarness is unavailable');
    const handle = Array.from(this.workers.values()).find((item) => item.deliveryId === deliveryId);
    if (!handle) throw new Error(`delivery worker not found: ${deliveryId}`);
    const view = await this.opts.deliveryHarness.decide(deliveryId, {
      kind: 'return-delivery',
      ...(candidateId ? { candidateId } : {}),
      feedback,
    });
    handle.report = null;
    handle.transportEnded = false;
    handle.suppressNextReportlessCompletion = false;
    this.applyDeliveryView(handle, view);
    await this.scheduleAutomaticRework(handle, view, {
      findings: [feedback],
    });
    return view;
  }

  async extendTaskBudget(
    taskId: string,
    expectedPlanVersion: number,
    rawBudget: TaskBudget,
    decisionId: string,
  ): Promise<{ planVersion: number; budget: TaskBudget }> {
    if (expectedPlanVersion !== this.planVersion) {
      throw new Error(
        `stale plan version: expected ${expectedPlanVersion}, current ${this.planVersion}`,
      );
    }
    if (!decisionId.trim()) throw new Error('budget extension decision id is required');
    const handle = this.workers.get(taskId);
    if (!handle) throw new Error(this.unknownTaskError(taskId));
    if (handle.status !== 'budget-paused') {
      throw new Error(`task ${taskId} is not paused by its budget`);
    }
    const budget = taskBudgetSchema.parse(rawBudget);
    const previous = handle.budget;
    const keys = [
      'maxAttempts',
      'maxTotalTokens',
      'maxTotalDurationMs',
      'maxStagnantAttempts',
    ] as const;
    if (keys.some((key) => budget[key] < previous[key])) {
      throw new Error('a budget extension cannot reduce an approved limit');
    }
    if (keys.every((key) => budget[key] === previous[key])) {
      throw new Error('a budget extension must increase at least one limit');
    }
    const view = handle.deliveryId
      ? this.opts.deliveryHarness?.snapshot(handle.deliveryId)
      : undefined;
    if (!view || view.status !== 'reworking') {
      throw new Error('paused task has no recoverable rework delivery');
    }
    handle.budget = structuredClone(budget);
    handle.budgetPauseReason = undefined;
    this.planVersion += 1;
    this.emitPlanUpdate();
    await this.opts.flushEvents?.();
    await this.scheduleAutomaticRework(handle, view, {
      findings: [
        `User decision ${decisionId} extended the bounded rework budget; continue addressing the existing findings.`,
      ],
    });
    return {
      planVersion: this.planVersion,
      budget: structuredClone(handle.budget),
    };
  }

  /** Coordinator review failures use the same durable budget gate as
   * deterministic verification failures. */
  async requestCoordinatorRework(
    deliveryId: string,
    session: CoordinatorReviewSession,
  ): Promise<DeliveryView> {
    if (!this.opts.deliveryHarness) throw new Error('DeliveryHarness is unavailable');
    const handle = Array.from(this.workers.values()).find((item) => item.deliveryId === deliveryId);
    if (!handle) throw new Error(`delivery worker not found: ${deliveryId}`);
    await reopenFrozenDeliveryCandidateForRework(session.candidate);
    const view = await this.opts.deliveryHarness.requestCoordinatorRework(deliveryId, session);
    this.applyDeliveryView(handle, view);
    await this.scheduleAutomaticRework(handle, view, {
      findings: session.rework?.findings.map((finding) => finding.message),
      affectedChunks: session.rework?.findings
        .filter((finding) => finding.path)
        .map((finding, index) => ({
          chunkId: `review-finding-${index + 1}`,
          path: finding.path!,
        })),
    });
    return view;
  }

  private async scheduleAutomaticRework(
    handle: WorkerHandle,
    view: DeliveryView,
    overrides: {
      findings?: string[];
      affectedChunks?: ReworkRequest['affectedChunks'];
    } = {},
  ): Promise<void> {
    if (view.status !== 'reworking') return;
    const key = `${view.id}:${view.attempt}`;
    const existing = this.automaticReworkByAttempt.get(key);
    if (existing) return existing;
    const run = this.runAutomaticRework(handle, view, overrides)
      .finally(() => this.automaticReworkByAttempt.delete(key));
    this.automaticReworkByAttempt.set(key, run);
    return run;
  }

  private async runAutomaticRework(
    handle: WorkerHandle,
    view: DeliveryView,
    overrides: {
      findings?: string[];
      affectedChunks?: ReworkRequest['affectedChunks'];
    },
  ): Promise<void> {
    const deliveryAttempt = view.attempts.find((attempt) => attempt.attempt === view.attempt);
    if (!deliveryAttempt) throw new Error(`delivery attempt ${view.attempt} is missing`);
    const failedChecks = [
      ...deliveryAttempt.report.tests
        .filter((test) => test.status !== 'passed')
        .map((test) => `${test.command}: ${test.summary ?? test.status}`),
      ...extractFailedVerificationChecks(deliveryAttempt.verification?.checks),
    ];
    const findings = overrides.findings?.filter(Boolean)
      ?? [
        view.error,
        deliveryAttempt.feedback,
        ...deliveryAttempt.report.unresolved
          .filter((item) => item.blocking)
          .map((item) => item.message),
      ].filter((item): item is string => Boolean(item));
    const effectiveFindings = findings.length > 0
      ? findings
      : ['Delivery did not satisfy the approved acceptance criteria.'];
    const relevantFiles = deliveryAttempt.report.files.map((file) => file.path);
    const evidenceHash = hashVisibleContextValue({
      report: deliveryAttempt.report,
      verification: deliveryAttempt.verification ?? null,
      review: deliveryAttempt.review ?? null,
    });
    if (!handle.budgetAttempts.some((attempt) => attempt.attempt === view.attempt)) {
      handle.budgetAttempts.push({
        attempt: view.attempt,
        tokenCost: null,
        reservedTokenCost: Math.max(
          1,
          handle.executionProfile?.maxTokenBudget
            ?? Math.min(DEFAULT_TASK_BUDGET.maxTotalTokens, 200_000),
        ),
        durationMs: Math.max(0, Date.now() - handle.startedAt),
        failureFingerprint: buildFailureFingerprint({
          error: effectiveFindings.join('\n'),
          failingChecks: failedChecks,
          relevantFiles,
          evidenceHash,
        }),
      });
    }
    const evaluation = evaluateTaskBudget(handle.budget, handle.budgetAttempts);
    if (evaluation !== 'continue') {
      handle.backendSession = handle.session?.snapshot?.() ?? handle.backendSession;
      const previousSession = handle.session;
      handle.session = null;
      handle.status = 'budget-paused';
      previousSession?.end();
      handle.budgetPauseReason = evaluation;
      handle.summary = evaluation === 'non-converging'
        ? 'Equivalent failures repeated without meaningful progress.'
        : 'The approved task rework budget is exhausted.';
      this.applyDeliveryView(handle, view);
      handle.status = 'budget-paused';
      this.emitPlanUpdate();
      this.emitCoordinatorBriefing({
        kind: 'failed',
        title: `${handle.title} 已暂停返工`,
        summary: handle.summary,
        blockers: [evaluation],
        recommendedAction: 'request-user-decision',
        workerId: handle.id,
        taskId: handle.currentTaskId,
      });
      await this.opts.flushEvents?.();
      return;
    }

    const authorityGrantHash = hashVisibleContextValue(handle.authorityRequest ?? {});
    const request = reworkRequestSchema.parse({
      schemaVersion: 1,
      findings: effectiveFindings,
      affectedChunks: overrides.affectedChunks ?? relevantFiles.map((path, index) => ({
        chunkId: `reported-file-${index + 1}`,
        path,
      })),
      failedChecks,
      expectedBehavior: handle.acceptanceCriteria?.length
        ? handle.acceptanceCriteria.map((criterion) => criterion.description)
        : ['The delivered result satisfies the approved task objective and verification checks.'],
      authorityGrantHash,
    });
    const nextAttempt = view.attempt + 1;
    const text = renderReworkRequest(request);
    await this.requireTaskMailbox().enqueue({
      taskId: handle.id,
      attempt: nextAttempt,
      sender: 'coordinator',
      kind: 'instruction',
      payload: {
        text,
        rework: request,
      },
    });
    // The mailbox event and current reworking projection are durable before
    // the next side-effecting Backend attempt begins.
    await this.opts.flushEvents?.();
    handle.backendSession = undefined;
    const previousSession = handle.session;
    handle.session = null;
    handle.attempt = nextAttempt;
    handle.status = 'pending';
    previousSession?.end();
    handle.summary = '';
    handle.report = null;
    handle.transportEnded = false;
    handle.suppressNextReportlessCompletion = false;
    handle.emittedCandidateId = undefined;
    handle.acceptedFinalized = false;
    handle.contextPackage = undefined;
    handle.contextPackageHash = undefined;
    handle.backendRuntime = undefined;
    handle.effectiveProfile = undefined;
    handle.authorityGrant = undefined;
    handle.budgetPauseReason = undefined;
    handle.startedAt = Date.now();
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
  }

  private recordSuccessfulBudgetAttempt(handle: WorkerHandle, attempt: number): void {
    if (handle.budgetAttempts.some((entry) => entry.attempt === attempt)) return;
    handle.budgetAttempts.push({
      attempt,
      tokenCost: null,
      reservedTokenCost: Math.max(
        1,
        handle.executionProfile?.maxTokenBudget
          ?? Math.min(DEFAULT_TASK_BUDGET.maxTotalTokens, 200_000),
      ),
      durationMs: Math.max(0, Date.now() - handle.startedAt),
      failureFingerprint: null,
      succeeded: true,
    });
    this.emitPlanUpdate();
  }

  // ===========================================================================
  // Internals

  private requireTaskMailbox(): TaskMailbox {
    if (!this.opts.taskMailbox) {
      throw new Error('durable task mailbox is unavailable');
    }
    return this.opts.taskMailbox;
  }

  private requiresFreshAttempt(status: WorkerStatusKind): boolean {
    return status !== 'pending' && status !== 'running';
  }

  private messageText(message: TaskMessage): string {
    if (
      message.payload
      && typeof message.payload === 'object'
      && typeof (message.payload as { text?: unknown }).text === 'string'
    ) {
      return (message.payload as { text: string }).text;
    }
    throw new Error(`task message ${message.id} has no text payload`);
  }

  private beginFollowUpAttempt(handle: WorkerHandle): void {
    handle.backendSession = handle.session?.snapshot?.() ?? handle.backendSession;
    if (handle.session) {
      const session = handle.session;
      handle.session = null;
      session.end();
    }
    // The previous attempt's permission cards are void once its session ends;
    // drop their fail-closed timers so they can't fire on the reused handle.
    this.clearPermissionTimersForHandle(handle.id);
    handle.attempt += 1;
    handle.status = 'pending';
    handle.summary = '';
    handle.report = null;
    handle.transportEnded = false;
    handle.suppressNextReportlessCompletion = false;
    handle.deliveryId = null;
    handle.emittedCandidateId = undefined;
    handle.acceptedFinalized = false;
    handle.contextPackage = undefined;
    handle.contextPackageHash = undefined;
    handle.backendRuntime = undefined;
    handle.effectiveProfile = undefined;
    handle.authorityGrant = undefined;
    handle.live = {
      lastAssistantText: '',
      currentTool: null,
      currentToolInput: null,
      lastUpdateTs: 0,
      busy: false,
    };
    this.emitPlanUpdate();
  }

  private async acknowledgeMailboxDelivery(handle: WorkerHandle): Promise<void> {
    const inFlight = this.mailboxAckInFlightByWorker.get(handle.id);
    if (inFlight) {
      // A concurrent ack is already draining this worker's mailbox - wait for
      // it and return. The drain loop below catches any message that arrived
      // during it, so the concurrent caller doesn't need to re-ack.
      await inFlight;
      return;
    }
    if (!this.opts.taskMailbox) return;
    const drain = (async () => {
      try {
        // Drain every pending ack one at a time. A steer delivered mid-ack
        // overwrites pendingMailboxAckByWorker with a newer id; only delete an
        // entry that still matches the id we just acknowledged, then loop to
        // catch the newer one. The previous unconditional delete wiped the
        // newer entry, leaving steeringMessageByWorker stuck on it forever
        // (which in turn made the `ended` handler swallow real crashes).
        let messageId = this.pendingMailboxAckByWorker.get(handle.id);
        while (messageId) {
          await this.opts.taskMailbox!.acknowledge(handle.id, messageId);
          if (this.pendingMailboxAckByWorker.get(handle.id) === messageId) {
            this.pendingMailboxAckByWorker.delete(handle.id);
          }
          if (this.steeringMessageByWorker.get(handle.id) === messageId) {
            this.steeringMessageByWorker.delete(handle.id);
          }
          messageId = this.pendingMailboxAckByWorker.get(handle.id);
        }
      } catch (error) {
        console.warn('[scheduler] task mailbox acknowledgement failed', {
          taskId: handle.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    this.mailboxAckInFlightByWorker.set(handle.id, drain);
    try {
      await drain;
    } finally {
      if (this.mailboxAckInFlightByWorker.get(handle.id) === drain) {
        this.mailboxAckInFlightByWorker.delete(handle.id);
      }
    }
  }

  private async deliverExistingSteer(
    handle: WorkerHandle,
    message: TaskMessage,
  ): Promise<void> {
    if (!this.opts.taskMailbox || !handle.session || handle.status !== 'running') return;
    const session = handle.session;
    this.steeringMessageByWorker.set(handle.id, message.id);
    try {
      await session.interrupt('steer');
      if (handle.session !== session || handle.status !== 'running') {
        this.steeringMessageByWorker.delete(handle.id);
        await this.opts.taskMailbox.markFailed(handle.id, message.id);
        return;
      }
      session.sendUserText(`(plan update) ${this.messageText(message)}`);
      await this.opts.taskMailbox.markDelivered(handle.id, message.id);
      this.pendingMailboxAckByWorker.set(handle.id, message.id);
    } catch {
      this.steeringMessageByWorker.delete(handle.id);
      await this.opts.taskMailbox.markFailed(handle.id, message.id).catch(() => undefined);
    }
  }

  private async deliverQueuedSteer(handle: WorkerHandle): Promise<void> {
    if (!this.opts.taskMailbox || this.steeringMessageByWorker.has(handle.id)) return;
    const message = this.opts.taskMailbox.list(handle.id)
      .find((entry) => (
        entry.attempt === handle.attempt
        && entry.kind === 'steer'
        && entry.status === 'queued'
      ));
    if (message) await this.deliverExistingSteer(handle, message);
  }

  private async deliverNextFollowUp(handle: WorkerHandle): Promise<void> {
    if (
      !this.opts.taskMailbox
      || !handle.session
      || handle.status !== 'running'
      || this.steeringMessageByWorker.has(handle.id)
    ) return;
    const message = this.opts.taskMailbox.list(handle.id)
      .find((entry) => (
        entry.attempt === handle.attempt
        && (entry.kind === 'follow-up' || entry.kind === 'instruction')
        && entry.status === 'queued'
      ));
    if (!message) return;
    try {
      handle.session.sendUserText(`(follow-up) ${this.messageText(message)}`);
      await this.opts.taskMailbox.markDelivered(handle.id, message.id);
      this.pendingMailboxAckByWorker.set(handle.id, message.id);
    } catch {
      await this.opts.taskMailbox.markFailed(handle.id, message.id).catch(() => undefined);
    }
  }

  private async requestMissingWorkReportRecovery(handle: WorkerHandle): Promise<boolean> {
    const mailbox = this.opts.taskMailbox;
    const session = handle.session;
    if (!mailbox || !session || handle.status !== 'running') return false;
    if (this.hasWorkReportRecovery(handle)) return false;

    const message = await mailbox.enqueue({
      taskId: handle.id,
      attempt: handle.attempt,
      sender: 'coordinator',
      kind: 'follow-up',
      payload: { text: WORK_REPORT_RECOVERY_MESSAGE },
    });
    try {
      session.sendUserText(`(follow-up) ${WORK_REPORT_RECOVERY_MESSAGE}`, 'high');
      await mailbox.markDelivered(handle.id, message.id);
      this.pendingMailboxAckByWorker.set(handle.id, message.id);
      handle.transportEnded = false;
      handle.live.busy = true;
      return true;
    } catch (error) {
      await mailbox.markFailed(handle.id, message.id).catch(() => undefined);
      console.warn('[scheduler] WorkReport recovery delivery failed', {
        taskId: handle.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private hasWorkReportRecovery(handle: WorkerHandle): boolean {
    return this.opts.taskMailbox?.list(handle.id).some((entry) => (
      entry.attempt === handle.attempt
      && entry.kind === 'follow-up'
      && this.messageText(entry) === WORK_REPORT_RECOVERY_MESSAGE
    )) ?? false;
  }

  private queuedInitialMessage(handle: WorkerHandle): TaskMessage | undefined {
    return this.opts.taskMailbox?.list(handle.id)
      .find((entry) => (
        entry.attempt === handle.attempt
        && (entry.kind === 'follow-up' || entry.kind === 'instruction')
        && entry.status === 'queued'
      ));
  }

  private registerHandle(spec: {
    id: string;
    title: string;
    prompt: string;
    deps: string[];
    supersedesTaskId?: string;
    specialty: WorkerSpecialtyKind;
    executorBackendId?: string;
    writePaths?: string[];
    executionProfile?: PlanMeetingTask['executionProfile'];
    contextSelection?: PlanMeetingTask['contextSelection'];
    workspaceMode?: PlanMeetingTask['workspaceMode'];
    authorityRequest?: PlanMeetingTask['authorityRequest'];
    dependencyGate?: 'reviewed' | 'accepted';
    budget?: TaskBudget;
    approvalDecisionId?: string;
    approvalRecordedAt?: number;
    approvedPlanVersion?: number;
    acceptanceCriteria?: AcceptanceCriterion[];
  }): void {
    const handle: WorkerHandle = {
      id: spec.id,
      title: spec.title,
      prompt: spec.prompt,
      deps: spec.deps,
      supersedesTaskId: spec.supersedesTaskId,
      executorBackendId: spec.executorBackendId,
      writePaths: spec.writePaths,
      executionProfile: spec.executionProfile,
      contextSelection: spec.contextSelection,
      workspaceMode: spec.workspaceMode,
      authorityRequest: spec.authorityRequest,
      dependencyGate: spec.dependencyGate ?? 'accepted',
      budget: structuredClone(spec.budget ?? DEFAULT_TASK_BUDGET),
      budgetAttempts: [],
      budgetPauseReason: undefined,
      authorityGrant: undefined,
      approvalDecisionId: spec.approvalDecisionId,
      approvalRecordedAt: spec.approvalRecordedAt,
      approvedPlanVersion: spec.approvedPlanVersion,
      contextPackage: undefined,
      contextPackageHash: undefined,
      backendRuntime: undefined,
      effectiveProfile: undefined,
      acceptanceCriteria: spec.acceptanceCriteria,
      status: 'pending',
      session: null,
      backendSession: undefined,
      summary: '',
      live: {
        lastAssistantText: '',
        currentTool: null,
        currentToolInput: null,
        lastUpdateTs: 0,
        busy: false,
      },
      pendingDelegateAck: false,
      queuedAddenda: [],
      bufferedUpdates: [],
      flushTimer: null,
      specialty: spec.specialty,
      startedAt: Date.now(),
      currentTaskId: `${spec.id}-task-1`,
      taskSeq: 1,
      taskHistory: [],
      deliveries: new Set<string>(),
      explicitDeliveries: [],
      workspace: null,
      workspaceDiagnostic: undefined,
      backendId: spec.executorBackendId ?? this.opts.defaultBackendId ?? 'claude-code',
      attempt: 1,
      eventSeq: 0,
      report: null,
      transportEnded: false,
      suppressNextReportlessCompletion: false,
      deliveryId: null,
      stallNotified: false,
      stallNudged: false,
      authorityDenyStreak: 0,
      lastAuthorityDenyReason: undefined,
    };
    this.workers.set(spec.id, handle);
  }

  private adaptTasksForWorkspaceBaseline(tasks: PlanMeetingTask[]): PlanMeetingTask[] {
    const inspect = this.opts.workspaceManager?.inspectBaseline;
    if (typeof inspect !== 'function') return tasks;
    const baseline = inspect.call(this.opts.workspaceManager);
    if (!baseline || baseline.kind === 'git-clean') return tasks;
    return tasks.map((task) => {
      const workspaceMode = coerceWorkspaceModeForBaseline(task.workspaceMode, baseline.kind);
      if (workspaceMode === task.workspaceMode) return task;
      return { ...task, workspaceMode };
    });
  }

  private isTerminalWorkerStatus(status: WorkerHandle['status']): boolean {
    return status === 'accepted'
      || status === 'done'
      || status === 'failed'
      || status === 'interrupted';
  }

  private satisfiedDependencyIds(): Set<string> {
    const ids = new Set<string>();
    for (const handle of this.workers.values()) {
      if (this.dependencyGateSatisfied(handle)) {
        ids.add(handle.id);
      }
    }
    return ids;
  }

  private listKnownTaskIds(): string[] {
    return Array.from(this.workers.keys()).sort((left, right) => left.localeCompare(right));
  }

  private unknownTaskError(taskId: string): string {
    const available = this.listKnownTaskIds();
    return available.length > 0
      ? `unknown task: ${taskId}; available: ${available.join(', ')}`
      : `unknown task: ${taskId}; available: (none)`;
  }

  /** Reuse of terminal task ids gets a numeric suffix; live collisions still fail. */
  private allocateInstallTaskIds(
    tasks: PlanMeetingTask[],
  ): { ok: true; tasks: PlanMeetingTask[] } | { ok: false; error: string } {
    const used = new Set(this.workers.keys());
    const rename = new Map<string, string>();
    const allocated: PlanMeetingTask[] = [];

    for (const task of tasks) {
      let id = task.id;
      if (used.has(id)) {
        const existing = this.workers.get(id);
        if (existing && !this.isTerminalWorkerStatus(existing.status)) {
          return { ok: false, error: `Worker id already in use: ${id}` };
        }
        let suffix = 2;
        while (used.has(`${task.id}-${suffix}`)) suffix += 1;
        id = `${task.id}-${suffix}`;
        rename.set(task.id, id);
      }
      used.add(id);
      allocated.push(id === task.id ? task : { ...task, id });
    }

    if (rename.size === 0) return { ok: true, tasks: allocated };
    return {
      ok: true,
      tasks: allocated.map((task) => ({
        ...task,
        deps: (task.deps ?? []).map((dep) => rename.get(dep) ?? dep),
      })),
    };
  }

  /** Find an idle worker with the same specialty that can take a new task.
   *  An idle worker has terminal status ('done' only — failed workers we
   *  leave alone so the user can inspect them) and no live session. */
  private findReusableWorker(specialty: WorkerSpecialtyKind): WorkerHandle | null {
    for (const handle of this.workers.values()) {
      if ((handle.status === 'accepted' || handle.status === 'done') && handle.session === null && handle.specialty === specialty) {
        return handle;
      }
    }
    return null;
  }

  /** Reassign a previously-done worker to a new task. Archives the just-
   *  completed task into taskHistory, resets transient state, then calls
   *  spawnWorker to bring up a fresh SDK subprocess under the same id. */
  private reassignWorker(handle: WorkerHandle, next: { title: string; prompt: string; deps?: string[] }): void {
    const finishedAt = Date.now();
    handle.taskHistory.push({
      id: handle.currentTaskId,
      title: handle.title,
      status: handle.status,
      startedAt: handle.startedAt,
      finishedAt,
      summary: handle.summary || undefined,
    });
    // Cap history length defensively so a single tile doesn't grow unbounded.
    if (handle.taskHistory.length > TASK_HISTORY_MAX) {
      handle.taskHistory.splice(0, handle.taskHistory.length - TASK_HISTORY_MAX);
    }
    handle.taskSeq += 1;
    handle.currentTaskId = `${handle.id}-task-${handle.taskSeq}`;
    handle.title = next.title;
    handle.prompt = next.prompt;
    handle.deps = next.deps ?? [];
    handle.status = 'pending';
    handle.summary = '';
    handle.startedAt = finishedAt;
    handle.live = {
      lastAssistantText: '',
      currentTool: null,
      currentToolInput: null,
      lastUpdateTs: 0,
      busy: false,
    };
    handle.bufferedUpdates = [];
    handle.queuedAddenda = [];
    handle.pendingDelegateAck = false;
    handle.deliveries.clear();
    handle.explicitDeliveries = [];
    handle.report = null;
    handle.backendRuntime = undefined;
    handle.effectiveProfile = undefined;
    handle.authorityGrant = undefined;
    handle.authorityAddendum = undefined;
    handle.pendingAuthorityAsks = undefined;
    handle.approvalDecisionId = undefined;
    handle.approvalRecordedAt = undefined;
    handle.approvedPlanVersion = undefined;
    handle.transportEnded = false;
    handle.suppressNextReportlessCompletion = false;
    handle.deliveryId = null;
    handle.emittedCandidateId = undefined;
    handle.acceptedFinalized = false;
    handle.backendSession = undefined;
    handle.attempt = 1;
    handle.eventSeq = 0;
    handle.stallNotified = false;
    handle.stallNudged = false;
    if (handle.flushTimer) {
      clearTimeout(handle.flushTimer);
      handle.flushTimer = null;
    }
    this.emitPlanUpdate();
    this.spawnWorker(handle);
  }

  private countRunning(): number {
    const active = new Set(this.launching);
    for (const handle of this.workers.values()) {
      if (!handle.session) continue;
      // Parked delivery statuses must not consume concurrency even if a
      // session pointer leaked; releaseWorkerSession is the primary free path.
      if (PARKED_SLOT_STATUSES.has(handle.status)) continue;
      if (['accepted', 'failed', 'interrupted', 'done', 'budget-paused'].includes(handle.status)) {
        continue;
      }
      active.add(handle.id);
    }
    return active.size;
  }

  /** End a Worker Backend session without terminalizing the handle. Returns
   *  true when a live session was released (slot may now be free). */
  private releaseWorkerSession(handle: WorkerHandle): boolean {
    if (!handle.session) return false;
    const session = handle.session;
    handle.backendSession = session.snapshot?.() ?? handle.backendSession;
    handle.session = null;
    handle.pendingDelegateAck = false;
    handle.live.busy = false;
    handle.live.currentTool = null;
    handle.live.currentToolInput = null;
    this.steeringMessageByWorker.delete(handle.id);
    this.clearPermissionTimersForHandle(handle.id);
    try {
      session.end();
    } catch (err) {
      console.warn(`[scheduler] parked worker.end() threw for ${handle.id}:`, err);
    }
    return true;
  }

  /** Whether dependents of this task may start under its dependencyGate. */
  /**
   * How far this upstream task has progressed for DAG release.
   * - accepted: Meeting-branch staging (or true empty-file report-only accept)
   * - reviewed: verification + review passed; not freeze-deferred / not conflict
   */
  private dependencyReleaseLevel(dependency: WorkerHandle): 'none' | 'reviewed' | 'accepted' {
    if (this.acceptedGateSatisfied(dependency)) return 'accepted';
    if (this.reviewedGateSatisfied(dependency)) return 'reviewed';
    return 'none';
  }

  private dependencyGateSatisfied(dependency: WorkerHandle): boolean {
    const level = this.dependencyReleaseLevel(dependency);
    if (dependency.dependencyGate === 'reviewed') {
      return level === 'reviewed' || level === 'accepted';
    }
    return level === 'accepted';
  }

  private deliverySnapshotFor(handle: WorkerHandle): DeliveryView | undefined {
    if (!handle.deliveryId || !this.opts.deliveryHarness) return undefined;
    return this.opts.deliveryHarness.snapshot(handle.deliveryId);
  }

  /** ADR-0001: writers open the accepted gate only after Meeting-branch staging. */
  private acceptedGateSatisfied(dependency: WorkerHandle): boolean {
    if (dependency.status !== 'accepted' && dependency.status !== 'done') return false;
    const delivery = this.deliverySnapshotFor(dependency);
    if (!delivery) {
      // Legacy shells without a DeliveryView — status alone.
      return true;
    }
    if (delivery.status !== 'accepted') {
      return dependency.status === 'done';
    }
    const kind = delivery.integration?.kind;
    if (kind === 'meeting-branch') return true;
    if (kind === 'report-only') {
      // Empty-file explore reports may accept without staging; file-bearing
      // report-only acceptance is rejected by the harness and must not release.
      return (dependency.report?.files.length ?? 0) === 0;
    }
    // Integrator stubs / non-git paths that returned an integration object
    // without a kind still completed the integrate() path (not report-only).
    if (delivery.integration && kind == null) return true;
    return false;
  }

  private reviewedGateSatisfied(dependency: WorkerHandle): boolean {
    if (!dependency.report) return false;
    if (!REVIEWED_GATE_STATUSES.has(dependency.status)) return false;
    if (dependency.status === 'awaiting-acceptance') {
      const delivery = this.deliverySnapshotFor(dependency);
      const candidate = delivery?.candidate;
      // Freeze-deferred writers never completed Coordinator coverage / freeze.
      if (candidate?.freezeDeferred) return false;
      // Legacy mislabel: reportOnly with files was the freeze-fail path.
      if (candidate?.reportOnly && candidate.report.files.length > 0) return false;
    }
    return true;
  }

  private async ensureTaskAuthority(
    handle: WorkerHandle,
    workspaceRoot: string,
  ): Promise<void> {
    if (
      handle.authorityGrant
      && handle.authorityGrant.attempt === handle.attempt
      && handle.authorityGrant.taskId === handle.id
    ) {
      return;
    }
    const compile = this.opts.compileTaskAuthority;
    const persist = this.opts.persistTaskAuthority;
    if (
      !compile
      || !persist
      || !handle.authorityRequest
      || !handle.approvalDecisionId
      || handle.approvalRecordedAt === undefined
      || handle.approvedPlanVersion === undefined
    ) {
      if (this.opts.taskAuthorityCompilerRequired) {
        throw new Error('approved task authority compiler is unavailable');
      }
      return;
    }
    const authorityGrant = taskAuthorityGrantSchema.parse(compile({
      taskId: handle.id,
      attempt: handle.attempt,
      planVersion: handle.approvedPlanVersion,
      approvalDecisionId: handle.approvalDecisionId,
      workspaceRoot,
      authorityRequest: structuredClone(handle.authorityRequest),
      approvedAt: handle.approvalRecordedAt,
    }));
    await persist({
      taskId: handle.id,
      attempt: handle.attempt,
      authorityGrant,
    });
    handle.authorityGrant = structuredClone(authorityGrant);
    // A fresh grant means a fresh attempt: hand approvals from the previous one
    // do not carry over.
    handle.authorityAddendum = undefined;
    handle.pendingAuthorityAsks = undefined;
  }

  private workspaceInputFor(handle: WorkerHandle): PrepareTaskWorkspaceInput {
    let mode = handle.workspaceMode;
    if (!mode) {
      // Compatibility for pre-collaboration delegate_task calls. Strict plan
      // tasks are normalized with an explicit workspaceMode before reaching
      // the Scheduler.
      mode = this.opts.workspaceManager?.inspectBaseline().kind === 'non-git'
        ? 'shared-locked'
        : 'git-worktree';
    }
    const integrationHead = this.opts.getIntegrationHead?.();
    return {
      mode,
      writePaths: handle.writePaths ? [...handle.writePaths] : [],
      ...(integrationHead ? { sourceRevision: integrationHead } : {}),
    };
  }

  private failInvalidWritePaths(handle: WorkerHandle, error: string): void {
    console.error(`[scheduler] invalid writePaths for ${handle.id}:`, error);
    handle.summary = error;
    this.opts.emit({
      source: 'talker',
      event: { kind: 'worker-ended', workerId: handle.id, status: 'failed', summary: error },
    });
    this.harvestUnresolvedAddenda(handle);
    this.disposeWorker(handle, 'failed', error);
    this.emitPlanUpdate();
    this.cascadeFailure(handle.id);
  }

  private spawnReadyWorkers(): void {
    for (const handle of this.workers.values()) {
      if (handle.status !== 'pending') continue;
      const allDepsDone = handle.deps.every((d) => {
        const dependency = this.workers.get(d);
        return dependency ? this.dependencyGateSatisfied(dependency) : false;
      });
      if (!allDepsDone) continue;
      if (this.countRunning() >= MAX_CONCURRENT_WORKERS) break;
      const input = this.workspaceInputFor(handle);
      const pathError = validateWorkspaceWritePaths(this.opts.cwd, input.writePaths);
      if (pathError) {
        this.failInvalidWritePaths(handle, pathError);
        continue;
      }
      if (this.opts.workspaceManager) {
        try {
          const block = typeof this.opts.workspaceManager.preparationBlock === 'function'
            ? this.opts.workspaceManager.preparationBlock(input)
            : null;
          if (block) {
            if (handle.workspaceDiagnostic?.code !== block.code) {
              handle.workspaceDiagnostic = block;
              handle.summary = block.message;
              const dirty = block.code === 'dirty-workspace-write-blocked';
              this.emitCoordinatorBriefing({
                kind: 'workspace-blocked',
                title: dirty
                  ? `任务「${handle.title}」被脏工作区阻止`
                  : `任务「${handle.title}」需要 Git 仓库`,
                summary: block.message,
                recommendedAction: 'revise-plan',
                workerId: handle.id,
                taskId: handle.id,
                blockers: dirty
                  ? [
                      '隔离 worktree 不会包含当前未提交改动。',
                      'AhaStation 不会自动 commit、stash 或复制这些改动。',
                      '共享锁定模式属于非受管兼容路径，不能自动集成或原子发布。',
                    ]
                  : [
                      '当前工作区不是 Git 仓库，无法创建隔离 worktree。',
                      '请将任务改为 shared-locked 兼容模式，或在仓库外初始化 Git。',
                    ],
              });
              this.emitPlanUpdate();
            }
            continue;
          }
          if (!this.opts.workspaceManager.canPrepare(handle.id, input)) continue;
          handle.workspaceDiagnostic = undefined;
        } catch (error) {
          // canPrepare/preparationBlock must not abort the whole spawn loop —
          // a single poisoned pending task previously blocked every new plan.
          const message = error instanceof Error ? error.message : String(error);
          this.failInvalidWritePaths(handle, message);
          continue;
        }
      }
      void this.spawnWorker(handle);
    }
    const running = this.countRunning();
    const waiting = Array.from(this.workers.values()).filter((handle) => (
      handle.status === 'pending'
      && !this.launching.has(handle.id)
      && handle.deps.every((dep) => {
        const dependency = this.workers.get(dep);
        return dependency ? this.dependencyGateSatisfied(dependency) : false;
      })
    )).length;
    if (running >= MAX_CONCURRENT_WORKERS && waiting > 0) {
      if (!this.capacityNotified) {
        this.capacityNotified = true;
        this.emitCoordinatorBriefing({
          kind: 'capacity',
          title: 'Worker 容量已满',
          summary: `${waiting} 个任务正在等待执行名额；当前任务不会被抢占。`,
          recommendedAction: 'continue',
          capacity: { running, limit: MAX_CONCURRENT_WORKERS, waiting },
        });
      }
    } else {
      this.capacityNotified = false;
    }
  }

  private async spawnWorker(handle: WorkerHandle): Promise<void> {
    this.launching.add(handle.id);
    // Surface the launch immediately so the renderer's capacity banner reserves
    // this slot during context/profile/workspace compilation (before status
    // flips to 'running'). Without this the banner lags one emit behind.
    this.emitPlanUpdate();
    try {
      let firstMessage = handle.prompt;
      if (handle.contextSelection && !handle.contextPackage) {
        const getSource = this.opts.getAuthorizedTaskContextSource;
        const persist = this.opts.persistContextPackage;
        if (!getSource || !persist) {
          if (this.opts.contextCompilerRequired) {
            throw new Error('authorized Context Package compiler is unavailable');
          }
        } else {
          const source = await getSource(handle.id, handle.contextSelection);
          const contextPackage = compileContextPackage({
            taskId: handle.id,
            attempt: handle.attempt,
            selection: handle.contextSelection,
            source,
            limits: {
              maxBytes: 512_000,
              maxEstimatedTokens: 128_000,
            },
          });
          await persist(contextPackage);
          handle.contextPackage = contextPackage;
          handle.contextPackageHash = contextPackage.packageHash;
        }
      }
      if (handle.contextPackage) {
        firstMessage = renderContextPackageForWorker(handle.prompt, handle.contextPackage);
      }

      if (handle.executionProfile && !handle.effectiveProfile) {
        const compile = this.opts.compileTaskProfile;
        const persist = this.opts.persistTaskProfile;
        if (!compile || !persist) {
          if (this.opts.taskProfileCompilerRequired) {
            throw new TaskProfileCompilationError('Backend task profile compiler is unavailable');
          }
        } else {
          try {
            const compiled = await compile(handle.executionProfile);
            const runtime = backendRuntimeSchema.parse(compiled.runtime);
            const effectiveProfile = backendEffectiveProfileSchema.parse(compiled.effectiveProfile);
            if (
              runtime.backendId !== handle.backendId
              || effectiveProfile.backendId !== handle.backendId
              || runtime.runtimeVersion !== effectiveProfile.runtimeVersion
            ) {
              throw new Error('compiled Backend task profile does not match the scheduled Backend');
            }
            await persist({
              taskId: handle.id,
              attempt: handle.attempt,
              requestedProfile: structuredClone(handle.executionProfile),
              runtime,
              effectiveProfile,
            });
            handle.backendRuntime = structuredClone(runtime);
            handle.effectiveProfile = structuredClone(effectiveProfile);
          } catch (error) {
            throw new TaskProfileCompilationError(
              `Backend task profile compilation failed: ${String(error)}`,
              { cause: error },
            );
          }
        }
      }

      const workerMcp = this.opts.buildWorkerMcp(handle.id, handle.attempt);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcpServers: Record<string, any> = { 'meeting-worker': workerMcp as any };
      let promptAppend = WORKER_PROMPT;
      if (handle.backendId === 'claude-code') promptAppend += CLAUDE_WORKER_PROMPT_SUFFIX;

      if (handle.specialty === 'computer-use' && this.opts.buildComputerUseMcp) {
        const cuMcp = this.opts.buildComputerUseMcp(handle.id);
        mcpServers['computer-use'] = cuMcp as any;
        promptAppend += COMPUTER_USE_WORKER_PROMPT;
      }

      if (this.opts.buildBrowserMcp) {
        const browserMcp = this.opts.buildBrowserMcp(handle.id);
        mcpServers['browser'] = browserMcp as any;
      }

      handle.workspace = this.opts.workspaceManager?.prepare(
        handle.id,
        this.workspaceInputFor(handle),
      ) ?? null;
      const workerCwd = handle.workspace?.cwd ?? this.opts.cwd;
      await this.ensureTaskAuthority(handle, workerCwd);
      if (this.opts.deliveryHarness && !handle.deliveryId) {
        const acceptanceCriteria = handle.acceptanceCriteria?.length
          ? handle.acceptanceCriteria
          : [{
              id: 'manual-acceptance',
              description: 'User reviews and accepts the delivered result.',
              verification: { kind: 'manual' as const },
            }];
        const proposed = await this.opts.deliveryHarness.propose({
          meetingId: this.opts.meetingId ?? 'meeting',
          taskId: handle.currentTaskId,
          objective: handle.prompt,
          workspace: workerCwd,
          sourceRevision: handle.workspace?.sourceRevision ?? 'non-git',
          acceptanceCriteria,
        });
        handle.deliveryId = proposed.id;
        void this.observeDelivery(handle, proposed.id);
        const executing = await this.opts.deliveryHarness.decide(proposed.id, {
          kind: 'approve-spec',
          specVersion: proposed.spec.version,
        });
        handle.attempt = executing.attempt;
      }
      const sessionFactory = this.opts.resolveSessionFactory?.(handle.backendId)
        ?? this.opts.sessionFactory;
      const sessionAttempt = handle.attempt;
      handle.session = sessionFactory({
        cwd: workerCwd,
        autoApproveScope: handle.authorityGrant ? 'off' : this.autoApproveScope,
        envOverride: this.opts.workerEnv,
        confirmDestructive: handle.authorityGrant
          ? undefined
          : this.opts.confirmDestructive,
        emit: (e) => this.onWorkerEvent(
          handle.id,
          e as unknown as BackendSessionEvent,
          sessionAttempt,
        ),
        sessionOptions: {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: promptAppend },
          mcpServers,
          ...(handle.backendSession?.sessionId
            ? { resumeSessionId: handle.backendSession.sessionId }
            : {}),
          ...(handle.effectiveProfile
            ? {
                model: handle.effectiveProfile.model,
                taskProfile: structuredClone(handle.effectiveProfile),
              }
            : {}),
        },
      });
      handle.status = 'running';
      // The launch is complete once the session exists and status is 'running':
      // stop reserving the slot via the launching flag so emitPlanUpdate below
      // reports launching=false. (The finally clause is a backstop for throws.)
      this.launching.delete(handle.id);
      handle.pendingDelegateAck = true;
      handle.queuedAddenda = [];
      handle.live.busy = true;
      handle.live.lastUpdateTs = Date.now();
      handle.stallNotified = false;
      handle.stallNudged = false;
      this.startStallWatch();
      const session = handle.session;
      await session.start();
      handle.backendSession = session.snapshot?.() ?? handle.backendSession;
      // The meeting may have ended, the task may have been cancelled, or an
      // auth-required event may have disposed the session during the handshake.
      if (handle.session !== session || handle.status !== 'running') return;

      // First prompt mentions peer workers so the new worker knows it may be
      // touching shared code with others.
      const peers = Array.from(this.workers.values()).filter(
        (h) => h.id !== handle.id && (h.status === 'running' || h.status === 'pending'),
      );
      const peerLine = peers.length > 0
        ? `\n\n（同事 worker 也在跑：${peers.map((p) => `${p.id}「${p.title}」`).join('、')}。注意可能改到同一份代码。）`
        : '';
      const initialMailboxMessage = this.queuedInitialMessage(handle);
      const mailboxLine = initialMailboxMessage
        ? `\n\n(follow-up attempt ${handle.attempt}) ${this.messageText(initialMailboxMessage)}`
        : '';
      try {
        session.sendUserText(
          `${handle.contextPackage ? firstMessage : handle.prompt + peerLine}${mailboxLine}`,
        );
        if (initialMailboxMessage && this.opts.taskMailbox) {
          await this.opts.taskMailbox.markDelivered(handle.id, initialMailboxMessage.id);
          this.pendingMailboxAckByWorker.set(handle.id, initialMailboxMessage.id);
        }
      } catch (error) {
        if (initialMailboxMessage && this.opts.taskMailbox) {
          await this.opts.taskMailbox.markFailed(handle.id, initialMailboxMessage.id).catch(() => undefined);
        }
        throw error;
      }

      this.opts.emit({
        source: 'talker',
        event: {
          kind: 'worker-spawned',
          workerId: handle.id,
          title: handle.title,
          deps: handle.deps,
          specialty: handle.specialty,
        },
      });
      this.emitPlanUpdate();
    } catch (err) {
      if (err instanceof DirtyWorkspaceWriteBlockedError) {
        const block = this.opts.workspaceManager
          && typeof this.opts.workspaceManager.preparationBlock === 'function'
          ? this.opts.workspaceManager.preparationBlock(this.workspaceInputFor(handle))
          : null;
        if (block) handle.workspaceDiagnostic = block;
        handle.summary = err.message;
        handle.status = 'pending';
        this.emitCoordinatorBriefing({
          kind: 'workspace-blocked',
          title: `任务「${handle.title}」被脏工作区阻止`,
          summary: err.message,
          recommendedAction: 'revise-plan',
          workerId: handle.id,
          taskId: handle.id,
          blockers: ['工作区在预检后发生变化；未创建 Worker，也未执行副作用。'],
        });
        this.emitPlanUpdate();
        return;
      }
      if (err instanceof TaskProfileCompilationError) {
        console.error(`[scheduler] task profile blocked ${handle.id}:`, err);
        handle.summary = err.message;
        this.opts.emit({
          source: 'talker',
          event: { kind: 'worker-ended', workerId: handle.id, status: 'interrupted', summary: err.message },
        });
        this.disposeWorker(handle, 'interrupted');
        this.emitPlanUpdate();
        return;
      }
      // auth-required/ended may have already terminalized this worker while the
      // awaited readiness promise was rejecting. Do not emit/cascade twice.
      if (
        handle.session === null
        && ['accepted', 'failed', 'interrupted', 'done'].includes(handle.status)
      ) return;
      // B2: anything throwing between sessionFactory and the first
      // sendUserText would otherwise strand the handle: status='pending'
      // (factory threw — and since spawnReadyWorkers retries on pending,
      // that's an infinite loop) or status='running' with a half-initialised
      // session that never receives its prompt. Treat as failure: dispose,
      // tombstone the tile, cascade.
      console.error(`[scheduler] spawnWorker failed for ${handle.id}:`, err);
      this.opts.emit({
        source: 'talker',
        event: { kind: 'worker-ended', workerId: handle.id, status: 'failed' },
      });
      this.harvestUnresolvedAddenda(handle);
      this.disposeWorker(handle, 'failed');
      this.emitPlanUpdate();
      this.cascadeFailure(handle.id);
    } finally {
      this.launching.delete(handle.id);
    }
  }

  /** B8: when a worker fails (SDK exit without WorkReport, spawn-time throw,
   *  cascade) any addenda that the user/Talker queued via steerWorker are
   *  about to be wiped by disposeWorker. Without this, those instructions
   *  vanish silently — the user sees no feedback and the Talker has no idea
   *  the steer never landed. Snapshot them BEFORE disposal and forward a
   *  single framed note to Talker so it can decide (re-delegate, abandon,
   *  surface to the user). */
  private harvestUnresolvedAddenda(handle: WorkerHandle): void {
    if (handle.queuedAddenda.length === 0) return;
    const lost = handle.queuedAddenda.slice();
    handle.queuedAddenda = [];
    const talker = this.talkerProvider();
    if (!talker) return;
    const joined = lost.map((a, i) => `  ${i + 1}. ${a}`).join('\n');
    talker.sendUserText(
      `(worker ${handle.id} failed with ${lost.length} unresolved instruction${lost.length === 1 ? '' : 's'} you previously queued via delegate_to/update:\n${joined}\nDecide whether to re-delegate, fold into a new task, or surface to the user.)`,
      'low',
    );
  }

  /** Release per-worker resources (SDK subprocess, flush timer, buffered
   *  updates, queued addenda, recent-edits entries) and stamp a terminal
   *  status onto the handle. We intentionally retain the handle in
   *  `this.workers` so that dependent workers' status checks still resolve
   *  correctly — the actual leak was the subprocess and listener handles,
   *  not the small handle object itself. The entries are flushed wholesale
   *  when `endAll()` calls `workers.clear()`.
   *
   *  Idempotent: safe to call again on an already-disposed handle. */
  private disposeWorker(handle: WorkerHandle, finalStatus: WorkerStatusKind, summary?: string): void {
    if (handle.flushTimer) {
      clearTimeout(handle.flushTimer);
      handle.flushTimer = null;
    }
    if (handle.session) {
      // Clear the reference before end(): some adapters emit `ended`
      // synchronously, which would otherwise re-enter disposeWorker and call
      // end repeatedly on the same session.
      const session = handle.session;
      handle.backendSession = session.snapshot?.() ?? handle.backendSession;
      handle.session = null;
      try {
        session.end();
      } catch (err) {
        console.warn(`[scheduler] worker.end() threw for ${handle.id}:`, err);
      }
    }
    handle.bufferedUpdates = [];
    handle.queuedAddenda = [];
    handle.pendingDelegateAck = false;
    this.steeringMessageByWorker.delete(handle.id);
    this.pendingMailboxAckByWorker.delete(handle.id);
    this.mailboxAckInFlightByWorker.delete(handle.id);
    this.clearPermissionTimersForHandle(handle.id);
    handle.live.busy = false;
    handle.live.currentTool = null;
    handle.live.currentToolInput = null;
    handle.status = finalStatus;
    // Delivery integration removes accepted worktrees. Failed/interrupted
    // worktrees are intentionally preserved for manual recovery.
    this.opts.workspaceManager?.release(handle.id, false);
    if (typeof summary === 'string') handle.summary = summary;
    // Drop any file-collision tracking pointing at this worker — without
    // this the recentEdits map keeps a stale workerId reference for up to
    // FILE_COLLISION_WINDOW_MS that can't fire anyway (worker is gone).
    for (const [path, edit] of this.recentEdits) {
      if (edit.workerId === handle.id) this.recentEdits.delete(path);
    }
  }

  private emitPlanUpdate(): void {
    const nodes: MeetingPlanNode[] = Array.from(this.workers.values()).map((h) => ({
      id: h.id,
      title: h.title,
      status: h.status,
      deps: h.deps,
      // Surface the launch window so the renderer's capacity banner matches the
      // backend's countRunning (which already reserves a slot via `launching`).
      ...(this.launching.has(h.id) ? { launching: true } : {}),
      supersedesTaskId: h.supersedesTaskId,
      executorBackendId: h.executorBackendId,
      writePaths: h.writePaths ? [...h.writePaths] : undefined,
      executionProfile: h.executionProfile ? structuredClone(h.executionProfile) : undefined,
      contextSelection: h.contextSelection ? structuredClone(h.contextSelection) : undefined,
      workspaceMode: h.workspaceMode,
      authorityRequest: h.authorityRequest ? structuredClone(h.authorityRequest) : undefined,
      dependencyGate: h.dependencyGate,
      // Authoritative DAG readiness — renderer capacity must not re-derive from status alone.
      dependencyRelease: this.dependencyReleaseLevel(h),
      budget: structuredClone(h.budget),
      budgetState: budgetStateFor(h),
      workspaceDiagnostic: h.workspaceDiagnostic
        ? structuredClone(h.workspaceDiagnostic)
        : undefined,
      ...(
        h.status === 'interrupted'
        || h.status === 'integration-conflict'
        || h.status === 'budget-paused'
          ? {
              recovery: assessTaskRecovery({
                status: h.status,
                workspaceMode: h.workspaceMode,
                authorityRequest: h.authorityRequest
                  ? structuredClone(h.authorityRequest)
                  : undefined,
              }),
            }
          : {}
      ),
    }));
    const plan: MeetingPlan = { version: this.planVersion, nodes };
    this.opts.emit({ source: 'talker', event: { kind: 'plan-updated', plan } });
  }

  private nextWorkerId(prefix: string): string {
    this.workerIdSeq += 1;
    return `${prefix}-${this.workerIdSeq}`;
  }

  private cascadeFailure(rootId: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const handle of this.workers.values()) {
        if (handle.status !== 'pending') continue;
        if (handle.deps.some((d) => this.workers.get(d)?.status === 'failed')) {
          // Pending nodes have no live session, but disposeWorker normalises
          // any stragglers (queued addenda, ad-hoc flush timers from
          // pre-spawn steering attempts) along with stamping the status.
          // B8: a pending node may still have user-queued addenda from a
          // pre-spawn steerWorker call — surface those to Talker before
          // they get wiped.
          this.harvestUnresolvedAddenda(handle);
          this.disposeWorker(handle, 'failed');
          changed = true;
          this.opts.emit({
            source: 'talker',
            event: { kind: 'worker-ended', workerId: handle.id, status: 'failed' },
          });
        }
      }
    }
    const talker = this.talkerProvider();
    if (talker) {
      talker.sendUserText(`(worker ${rootId} failed before an accepted delivery — downstream tasks marked failed)`, 'low');
    }
    this.emitPlanUpdate();
  }

  // Coalesce a burst of per-worker events into ONE injected user message to
  // Talker so we don't flood its context.
  //
  // When the user has 播报过滤 set to 'strict' we skip this entire pipeline:
  // the tool-call play-by-play (`[id] started Read: /path`, `[id] finished
  // Bash`, `[id] thought: ...`, `[id] turn complete`) is exactly the noise
  // the toggle promises to silence, and it's also what was leaking into the
  // talker's context and getting echoed back to the user. The high-signal
  // talker notifications (task_done summaries, failures, file collisions,
  // plan updates) all take their own direct sendUserText paths, so dropping
  // queueWorkerUpdate doesn't blind the talker — it just stops the chatter.
  private queueWorkerUpdate(handle: WorkerHandle, line: string): void {
    if (this.opts.getSpeechFilterMode() === 'strict') return;
    handle.bufferedUpdates.push(line);
    if (handle.bufferedUpdates.length > QUEUED_UPDATE_MAX) {
      handle.bufferedUpdates.splice(0, handle.bufferedUpdates.length - QUEUED_UPDATE_MAX);
    }
    if (handle.flushTimer) return;
    handle.flushTimer = setTimeout(() => {
      handle.flushTimer = null;
      if (this.opts.isClosed()) return;
      const batch = handle.bufferedUpdates;
      handle.bufferedUpdates = [];
      const talker = this.talkerProvider();
      if (batch.length === 0 || !talker) return;
      // Re-check at flush time: if the user flipped on strict during the
      // 1.2s debounce, honour it instead of shipping a stale batch.
      if (this.opts.getSpeechFilterMode() === 'strict') return;
      const text = `(worker ${handle.id} update)\n${batch.join('\n')}`;
      talker.sendUserText(text, 'low');
    }, QUEUED_UPDATE_FLUSH_MS);
  }

  private emitCoordinatorBriefing(
    input: Omit<CoordinatorBriefing, 'id' | 'timestamp' | 'completedTasks' | 'failedTasks' | 'files' | 'testsPassed' | 'testsFailed' | 'blockers'> & {
      completedTasks?: number;
      failedTasks?: number;
      files?: number;
      testsPassed?: number;
      testsFailed?: number;
      blockers?: string[];
    },
  ): void {
    const completedTasks = Array.from(this.workers.values())
      .filter((worker) => worker.status === 'accepted').length;
    const failedTasks = Array.from(this.workers.values())
      .filter((worker) => worker.status === 'failed').length;
    const briefing: CoordinatorBriefing = {
      id: randomUUID(),
      timestamp: Date.now(),
      completedTasks,
      failedTasks,
      files: 0,
      testsPassed: 0,
      testsFailed: 0,
      blockers: [],
      ...input,
    };
    this.opts.emit({
      source: 'system',
      event: { kind: 'coordinator-briefing', briefing },
    });
    this.talkerProvider()?.sendUserText(
      `[structured coordinator briefing]\n${JSON.stringify(briefing)}\n`
      + 'Use this summary to decide whether to continue, request rework, revise the plan, or ask the user. Do not echo raw Worker logs.',
      'high',
    );
  }

  /** Orchestrator-facing seam to push a structured Coordinator briefing for
   *  stalls that aren't tied to a Worker handle (e.g. a host-to-host ask that
   *  never got a reply). Emits the event and nudges the Coordinator talker. */
  briefCoordinator(input: {
    kind: CoordinatorBriefing['kind'];
    title: string;
    summary: string;
    recommendedAction: CoordinatorBriefing['recommendedAction'];
    blockers?: string[];
    workerId?: string;
    taskId?: string;
  }): void {
    this.emitCoordinatorBriefing(input);
  }

  private recordFileEdit(workerId: string, path: string): void {
    const now = Date.now();
    // Sweep expired entries cheaply.
    for (const [key, entry] of this.recentEdits) {
      if (now - entry.ts > FILE_COLLISION_WINDOW_MS) this.recentEdits.delete(key);
    }
    const prior = this.recentEdits.get(path);
    if (prior && prior.workerId !== workerId && (now - prior.ts) < FILE_COLLISION_WINDOW_MS) {
      const talker = this.talkerProvider();
      if (talker) {
        talker.sendUserText(
          `(file collision) worker ${workerId} and worker ${prior.workerId} both touched ${path} within ${Math.round((now - prior.ts) / 1000)}s. 提醒用户可能有冲突。`,
          'low',
        );
      }
    }
    this.recentEdits.set(path, { workerId, ts: now });
  }
}
