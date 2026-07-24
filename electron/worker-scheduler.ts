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
// pre-bound `buildWorkerMcp(workerId)` factory.
//
// The dispose / endAll path is idempotent: every native handle (SDK session,
// flush timer, recent-edit pointer) is released exactly once, even if the
// SDK 'ended' event arrives after end() already disposed the same handle.

import type { ClaudeSession } from './claude-session.js';
import type {
  BackendSession,
  BackendSessionEvent,
} from './backends/cli-backend.js';
import type {
  NativePermissionRequest,
  PermissionNormalizationResult,
} from './backends/canonical-execution.js';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import {
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
} from './task-collaboration.js';
import {
  backendRuntimeSchema,
  type BackendRuntime,
} from './backends/task-profile.js';
import type { DeliveryHarness, DeliveryView } from './delivery-harness.js';
import {
  parseWorkerAdapterSignal,
  type AcceptanceCriterion,
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
import { decideTaskPermission } from './permission-broker.js';

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
  buildWorkerMcp: (workerId: string) => unknown;
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
const TASK_HISTORY_MAX = 50;

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
        const pending = h.deps.filter((d) => this.workers.get(d)?.status !== 'accepted');
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
    executorBackendId?: string;
    writePaths?: string[];
    executionProfile?: PlanMeetingTask['executionProfile'];
    contextSelection?: PlanMeetingTask['contextSelection'];
    workspaceMode?: PlanMeetingTask['workspaceMode'];
    authorityRequest?: PlanMeetingTask['authorityRequest'];
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
    deliveryId?: string;
    delivery?: DeliveryView;
    attempt?: number;
    summary?: string;
  }> {
    return Array.from(this.workers.values()).map((handle) => ({
      id: handle.id,
      title: handle.title,
      prompt: handle.prompt,
      status: handle.status,
      deps: [...handle.deps],
      executorBackendId: handle.executorBackendId,
      writePaths: handle.writePaths ? [...handle.writePaths] : undefined,
      executionProfile: handle.executionProfile ? structuredClone(handle.executionProfile) : undefined,
      contextSelection: handle.contextSelection ? structuredClone(handle.contextSelection) : undefined,
      workspaceMode: handle.workspaceMode,
      authorityRequest: handle.authorityRequest ? structuredClone(handle.authorityRequest) : undefined,
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
      deliveryId: handle.deliveryId ?? undefined,
      delivery: handle.deliveryId
        ? this.opts.deliveryHarness?.snapshot(handle.deliveryId)
        : undefined,
      attempt: handle.attempt,
      summary: handle.summary || undefined,
    }));
  }

  getPlanVersion(): number {
    return this.planVersion;
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
      if (!dependency || dependency.status !== 'accepted' || !dependency.report) return [];
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
        specialty: inferSpecialty(`${String(task.title ?? id)} ${prompt}`),
        executorBackendId: normalized.executorBackendId,
        writePaths: normalized.writePaths,
        executionProfile: normalized.executionProfile,
        contextSelection: normalized.contextSelection,
        workspaceMode: normalized.workspaceMode,
        authorityRequest: normalized.authorityRequest,
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
      const rawStatus = typeof task.status === 'string' ? task.status : 'interrupted';
      handle.status = (
        rawStatus === 'accepted' || rawStatus === 'failed' || rawStatus === 'done'
      ) ? rawStatus : 'interrupted';
      handle.summary = typeof task.summary === 'string' ? task.summary : '';
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
    action: 'continue' | 'retry' | 'abandon',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const handle = this.workers.get(taskId);
    if (!handle) return { ok: false, error: 'interrupted task not found' };
    if (handle.status !== 'interrupted') {
      return { ok: false, error: `task is already ${handle.status}` };
    }
    if (action === 'abandon') {
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
          mode: action,
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
    handle.backendRuntime = undefined;
    handle.effectiveProfile = undefined;
    handle.authorityGrant = undefined;
    handle.transportEnded = false;
    handle.summary = '';
    handle.prompt = action === 'continue'
      ? `(recovery continuation) Inspect the existing workspace state and continue safely. Do not repeat external side effects without checking first.\n\n${handle.prompt}`
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
    for (const handle of this.workers.values()) {
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

  async interruptWorker(workerId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const handle = this.workers.get(workerId);
    if (!handle) return { ok: false, error: 'worker not found' };
    if (!handle.session || handle.status !== 'running') {
      return { ok: false, error: `worker cannot be interrupted in ${handle.status}` };
    }
    const session = handle.session;
    try {
      await session.interrupt('user');
      if (handle.session === session && handle.status === 'running') {
        await this.handleWorkerSignal(handle, { kind: 'ended', reason: 'interrupted' });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
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
      ).tasks;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const err = validatePlan(tasks);
    if (err) return { ok: false, error: err.message };
    for (const task of tasks) {
      if (this.workers.has(task.id)) {
        return { ok: false, error: `Worker id already in use: ${task.id}` };
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

  revisePlan(
    expectedPlanVersion: number,
    operations: PlanRevisionOperation[],
  ): { ok: true; planVersion: number } | { ok: false; error: string } {
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
      if (!handle) return { ok: false, error: `unknown task: ${operation.taskId}` };
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
        if (!task) return { ok: false, error: `unknown task: ${operation.taskId}` };
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
        });
        continue;
      }
      if (handle.status !== 'running' || !handle.session) {
        return {
          ok: false,
          error: `task ${operation.taskId} cannot be steered while ${handle.status}`,
        };
      }
    }

    const graphError = validatePlan(Array.from(projected.values()));
    if (graphError) return { ok: false, error: graphError.message };

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
          acceptanceCriteria: operation.task.acceptanceCriteria,
        });
      } else if (operation.kind === 'cancel-pending-task') {
        const handle = this.workers.get(operation.taskId)!;
        if (handle.flushTimer) clearTimeout(handle.flushTimer);
        this.workers.delete(operation.taskId);
      } else if (operation.kind === 'steer-running-task') {
        const result = this.steerWorker(operation.taskId, operation.addendum);
        if (!result.ok) {
          throw new Error(`validated steer failed for ${operation.taskId}: ${result.reason}`);
        }
      } else {
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
      }
    }

    this.planVersion += 1;
    this.emitPlanUpdate();
    this.spawnReadyWorkers();
    return { ok: true, planVersion: this.planVersion };
  }

  steerWorker(workerId: string, addendum: string): SteerResult {
    const handle = this.workers.get(workerId);
    if (!handle) return { ok: false, reason: 'unknown' };
    // B7: addenda for a worker the user can no longer steer used to vanish
    // silently. Surface the actual state so the MCP tool can tell Talker to
    // re-dispatch instead of pretending it landed.
    if (handle.status === 'done') return { ok: false, reason: 'done' };
    if (handle.status === 'failed') return { ok: false, reason: 'failed' };
    if (!handle.session) return { ok: false, reason: 'no-session' };
    if (handle.pendingDelegateAck) {
      handle.queuedAddenda.push(addendum);
      return { ok: true, queued: true };
    }
    void (async () => {
      try {
        await handle.session?.interrupt('steer');
        if (!handle.session || handle.status !== 'running') {
          handle.queuedAddenda.push(addendum);
          this.harvestUnresolvedAddenda(handle);
          return;
        }
        handle.session.sendUserText(`(plan update) ${addendum}`);
      } catch (err) {
        console.error(`[scheduler] steerWorker failed for ${workerId}:`, err);
      }
    })();
    handle.live.busy = true;
    handle.live.lastUpdateTs = Date.now();
    handle.stallNotified = false;
    handle.stallNudged = false;
    return { ok: true, queued: false };
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
    let anyRunning = false;
    for (const handle of this.workers.values()) {
      if (handle.status !== 'running' || !handle.session) continue;
      anyRunning = true;
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
    }
    if (!anyRunning) this.stopStallWatch();
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
          if (handle.pendingDelegateAck) {
            handle.pendingDelegateAck = false;
            if (handle.queuedAddenda.length > 0) {
              this.flushQueuedAddenda(handle);
            }
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
        // SDK stream end is transport state, never delivery success. A report
        // already being verified is allowed to finish; an unreported running
        // Worker is failed closed by handleWorkerSignal.
        if (handle.status === 'running' || handle.report) {
          void this.handleWorkerSignal(handle, { kind: 'ended', reason: 'completed' });
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
    const canonical = decideTaskPermission(normalized, handle.authorityGrant);
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
      handle.session?.resolvePermission(event.id, 'allow', canonical.decision.reason);
      return;
    }
    if (canonical.decision.kind === 'deny') {
      handle.session?.resolvePermission(event.id, 'deny', canonical.decision.reason);
      return;
    }
    this.opts.emit({
      source: handle.id,
      event: {
        ...event,
        input: canonical.safeInput,
      },
    });
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
    const event = this.createWorkerEvent(handle, signal);
    this.opts.emit({ source: handle.id, event: { kind: 'worker-event', event } });

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
      }
      return;
    }
    if (signal.kind === 'ended') {
      handle.live.busy = false;
      handle.transportEnded = true;
      if (
        signal.reason !== 'interrupted'
        && !handle.report
        && handle.status === 'running'
      ) {
        await this.handleWorkerSignal(handle, {
          kind: 'failed',
          code: 'missing-work-report',
          message: 'Worker turn ended without a valid WorkReport.',
          retryable: true,
        });
      } else if (signal.reason === 'interrupted' && handle.status === 'running') {
        handle.status = 'interrupted';
        this.disposeWorker(handle, 'interrupted', 'Worker turn was interrupted.');
        this.emitPlanUpdate();
      }
      return;
    }
    if (handle.report) {
      console.warn('[scheduler] duplicate WorkReport ignored', {
        workerId: handle.id,
        taskId: handle.currentTaskId,
        attempt: handle.attempt,
      });
      return;
    }

    handle.report = signal.report;
    handle.summary = signal.report.summary;
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
    this.emitPlanUpdate();
    const view = await this.opts.deliveryHarness.submitExternalReport(handle.deliveryId, signal.report);
    handle.attempt = view.attempt;
    this.applyDeliveryView(handle, view);
    if (view.status === 'awaiting-delivery-acceptance') {
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

  private applyDeliveryView(handle: WorkerHandle, view: DeliveryView): void {
    const mapped: Partial<Record<DeliveryView['status'], WorkerStatusKind>> = {
      executing: 'running',
      verifying: 'verifying',
      reviewing: 'reviewing',
      'awaiting-delivery-acceptance': 'awaiting-acceptance',
      reworking: 'reworking',
      accepted: 'accepted',
      interrupted: 'interrupted',
      failed: 'failed',
      cancelled: 'failed',
    };
    const next = mapped[view.status];
    if (next) handle.status = next;
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
    // The accepted delivery must be durable before it can release DAG
    // dependencies. Otherwise a crash can leave a downstream task running
    // while recovery sees its prerequisite as unaccepted.
    await this.opts.flushEvents?.();
    this.disposeWorker(handle, 'accepted', handle.summary);
    this.opts.workspaceManager?.release(handle.id, false);
    this.opts.emit({
      source: 'talker',
      event: { kind: 'worker-ended', workerId: handle.id, status: 'accepted', summary: handle.summary },
    });
    this.emitCoordinatorBriefing({
      kind: 'accepted',
      title: `${handle.title} 已接受`,
      summary: handle.summary || 'Delivery accepted.',
      recommendedAction: 'continue',
      workerId: handle.id,
      taskId: handle.currentTaskId,
    });
    this.spawnReadyWorkers();
    return view;
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
    this.applyDeliveryView(handle, view);
    handle.authorityGrant = undefined;
    // Rework is also journal-first: do not send a new side-effecting turn
    // until recovery can observe the new attempt state.
    await this.opts.flushEvents?.();
    // An authority grant is attempt-bound. Rework therefore starts a fresh
    // Backend session instead of reusing a tool-capable session that was
    // created under the previous attempt's grant.
    handle.session?.end();
    handle.session = null;
    handle.status = 'pending';
    handle.contextPackage = undefined;
    handle.contextPackageHash = undefined;
    handle.backendRuntime = undefined;
    handle.effectiveProfile = undefined;
    handle.authorityGrant = undefined;
    this.emitPlanUpdate();
    void this.spawnWorker(handle);
    return view;
  }

  // ===========================================================================
  // Internals

  private registerHandle(spec: {
    id: string;
    title: string;
    prompt: string;
    deps: string[];
    specialty: WorkerSpecialtyKind;
    executorBackendId?: string;
    writePaths?: string[];
    executionProfile?: PlanMeetingTask['executionProfile'];
    contextSelection?: PlanMeetingTask['contextSelection'];
    workspaceMode?: PlanMeetingTask['workspaceMode'];
    authorityRequest?: PlanMeetingTask['authorityRequest'];
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
      executorBackendId: spec.executorBackendId,
      writePaths: spec.writePaths,
      executionProfile: spec.executionProfile,
      contextSelection: spec.contextSelection,
      workspaceMode: spec.workspaceMode,
      authorityRequest: spec.authorityRequest,
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
      deliveryId: null,
      stallNotified: false,
      stallNudged: false,
    };
    this.workers.set(spec.id, handle);
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
    handle.approvalDecisionId = undefined;
    handle.approvalRecordedAt = undefined;
    handle.approvedPlanVersion = undefined;
    handle.transportEnded = false;
    handle.deliveryId = null;
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
      if (
        handle.session
        && !['accepted', 'failed', 'interrupted', 'done'].includes(handle.status)
      ) {
        active.add(handle.id);
      }
    }
    return active.size;
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
    return {
      mode,
      writePaths: handle.writePaths ? [...handle.writePaths] : [],
    };
  }

  private spawnReadyWorkers(): void {
    for (const handle of this.workers.values()) {
      if (handle.status !== 'pending') continue;
      const allDepsDone = handle.deps.every((d) => this.workers.get(d)?.status === 'accepted');
      if (!allDepsDone) continue;
      if (this.countRunning() >= MAX_CONCURRENT_WORKERS) break;
      if (this.opts.workspaceManager) {
        const input = this.workspaceInputFor(handle);
        const block = typeof this.opts.workspaceManager.preparationBlock === 'function'
          ? this.opts.workspaceManager.preparationBlock(input)
          : null;
        if (block) {
          if (handle.workspaceDiagnostic?.code !== block.code) {
            handle.workspaceDiagnostic = block;
            handle.summary = block.message;
            this.emitCoordinatorBriefing({
              kind: 'workspace-blocked',
              title: `任务「${handle.title}」被脏工作区阻止`,
              summary: block.message,
              recommendedAction: 'revise-plan',
              workerId: handle.id,
              taskId: handle.id,
              blockers: [
                '隔离 worktree 不会包含当前未提交改动。',
                'AhaStation 不会自动 commit、stash 或复制这些改动。',
                '共享锁定模式属于非受管兼容路径，不能自动集成或原子发布。',
              ],
            });
            this.emitPlanUpdate();
          }
          continue;
        }
        if (!this.opts.workspaceManager.canPrepare(handle.id, input)) continue;
        handle.workspaceDiagnostic = undefined;
      }
      void this.spawnWorker(handle);
    }
    const running = this.countRunning();
    const waiting = Array.from(this.workers.values()).filter((handle) => (
      handle.status === 'pending'
      && !this.launching.has(handle.id)
      && handle.deps.every((dep) => this.workers.get(dep)?.status === 'accepted')
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

      const workerMcp = this.opts.buildWorkerMcp(handle.id);
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
          ...(handle.effectiveProfile
            ? {
                model: handle.effectiveProfile.model,
                taskProfile: structuredClone(handle.effectiveProfile),
              }
            : {}),
        },
      });
      handle.status = 'running';
      handle.pendingDelegateAck = true;
      handle.queuedAddenda = [];
      handle.live.busy = true;
      handle.live.lastUpdateTs = Date.now();
      handle.stallNotified = false;
      handle.stallNudged = false;
      this.startStallWatch();
      const session = handle.session;
      await session.start();
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
      session.sendUserText(handle.contextPackage ? firstMessage : handle.prompt + peerLine);

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
      executorBackendId: h.executorBackendId,
      writePaths: h.writePaths ? [...h.writePaths] : undefined,
      executionProfile: h.executionProfile ? structuredClone(h.executionProfile) : undefined,
      contextSelection: h.contextSelection ? structuredClone(h.contextSelection) : undefined,
      workspaceMode: h.workspaceMode,
      authorityRequest: h.authorityRequest ? structuredClone(h.authorityRequest) : undefined,
      workspaceDiagnostic: h.workspaceDiagnostic
        ? structuredClone(h.workspaceDiagnostic)
        : undefined,
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

  private flushQueuedAddenda(handle: WorkerHandle): void {
    const batch = handle.queuedAddenda;
    handle.queuedAddenda = [];
    if (batch.length === 0 || !handle.session) return;
    void (async () => {
      try {
        await handle.session?.interrupt('steer');
        if (!handle.session || handle.status !== 'running') {
          handle.queuedAddenda.push(...batch);
          this.harvestUnresolvedAddenda(handle);
          return;
        }
        handle.session.sendUserText(`(plan update) ${batch.join('\n')}`);
      } catch (err) {
        console.error(`[scheduler] flushQueuedAddenda failed for ${handle.id}:`, err);
      }
    })();
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
