// orchestrator-types.ts — type definitions shared between orchestrator.ts,
// meeting-mcp.ts and recap.ts. Pulled out so submodules don't need to import
// the orchestrator class just to reach a type.
//
// These mirror the renderer-side types in src/types.ts: we can't cross the
// tsconfig rootDir boundary so the shapes are duplicated. Keep both files in
// sync when adding fields.

import type { SessionEvent } from './claude-session.js';
import type {
  BackendSession,
  BackendSessionSnapshot,
} from './backends/cli-backend.js';
import type { PlanMeetingTask } from './meeting-tools.js';
import type { TaskWorkspace } from './task-workspace.js';
import type { WorkspaceBlockedDiagnostic } from './task-workspace.js';
import type { DeliveryView } from './delivery-harness.js';
import type { MeetingDelivery, FinalMeetingDecision } from './meeting-delivery.js';
import type { WorkReport, WorkerEvent } from './worker-protocol.js';
import type { TaskBudgetAttempt } from './task-budget.js';

export type {
  BackendEffectiveProfile,
  ContextPackage,
  LegacyDeliveryEvidence,
  MeetingTaskRecord,
  MeetingTaskStatus,
  TaskAttemptRecord,
  TaskAuthorityGrant,
  TaskExecutionProfile,
  TaskMessage,
  TaskWorkspaceSnapshot,
} from './task-collaboration.js';

export type OrchestratorSource = 'talker' | string;

export type WorkerStatusKind =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'coordinator-reviewing'
  | 'awaiting-acceptance'
  | 'integration-queued'
  | 'integrating'
  | 'integration-conflict'
  | 'reworking'
  | 'budget-paused'
  | 'accepted'
  | 'interrupted'
  | 'done'
  | 'failed';

export type WorkerSpecialtyKind =
  | 'general'
  | 'frontend'
  | 'backend'
  | 'electron'
  | 'devops'
  | 'test'
  | 'docs'
  | 'review'
  | 'computer-use';

export interface MeetingPlanNode {
  id: string;
  title: string;
  status: WorkerStatusKind;
  deps: string[];
  /** Immutable accepted task replaced by this versioned rework node. */
  supersedesTaskId?: string;
  executorBackendId?: string;
  writePaths?: string[];
  executionProfile?: PlanMeetingTask['executionProfile'];
  contextSelection?: PlanMeetingTask['contextSelection'];
  workspaceMode?: PlanMeetingTask['workspaceMode'];
  authorityRequest?: PlanMeetingTask['authorityRequest'];
  budget?: PlanMeetingTask['budget'];
  budgetState?: {
    attempts: number;
    totalTokens: number;
    totalDurationMs: number;
    stagnantAttempts: number;
    reason?: string;
  };
  workspaceDiagnostic?: WorkspaceBlockedDiagnostic;
  recovery?: {
    classification: string;
    reasonCode: string;
    allowedActions: string[];
    autoResume: boolean;
  };
}

export interface MeetingPlan {
  version: number;
  nodes: MeetingPlanNode[];
}

export interface CoordinatorBriefing {
  id: string;
  timestamp: number;
  kind: 'delivery-ready' | 'accepted' | 'failed' | 'stalled' | 'capacity' | 'workspace-blocked';
  title: string;
  summary: string;
  completedTasks: number;
  failedTasks: number;
  files: number;
  testsPassed: number;
  testsFailed: number;
  blockers: string[];
  recommendedAction: 'continue' | 'review' | 'rework' | 'revise-plan' | 'request-user-decision';
  workerId?: string;
  taskId?: string;
  capacity?: { running: number; limit: number; waiting: number };
}

/** A single deliverable produced by a worker turn. Path is absolute on disk;
 *  the renderer fetches the file contents via the `documents:read` IPC and
 *  classifies the kind there so this event stays small. */
export interface WorkerDeliveryFile {
  path: string;
  snapshotPath?: string;
  /** Legacy recovery field from builds that stored snapshots in the project. */
  snapshotRelativePath?: string;
  sizeBytes?: number;
  sha256?: string;
  previewStatus?: 'copied' | 'too-large' | 'missing' | 'invalid' | 'copy-failed';
}

// Orchestrator-only events (alongside session events emitted from a worker/talker).
// `session-ready` / `session-start-failed` are emitted by the IPC layer (not the
// orchestrator itself) once the background `orch.start()` settles, so the
// renderer can flip the slot's status from 'starting' → 'ready' or 'failed' and
// replay any queued input.
export type OrchestratorOnlyEvent =
  | { kind: 'worker-spawned'; workerId: string; title: string; deps: string[]; specialty: WorkerSpecialtyKind }
  | { kind: 'worker-ended'; workerId: string; status: WorkerStatusKind; summary?: string }
  | { kind: 'worker-stalled'; workerId: string; title: string; idleMs: number; currentTool: string | null }
  | { kind: 'worker-delivery'; workerId: string; title: string; summary: string; taskId: string; deliveryId: string; files: WorkerDeliveryFile[] }
  | { kind: 'permission-cancelled'; id: string }
  | { kind: 'worker-event'; event: WorkerEvent }
  | { kind: 'delivery-status'; workerId: string; taskId: string; delivery: DeliveryView }
  | { kind: 'meeting-delivery-updated'; delivery: MeetingDelivery | null; decision: FinalMeetingDecision | null }
  | { kind: 'coordinator-briefing'; briefing: CoordinatorBriefing }
  | { kind: 'plan-updated'; plan: MeetingPlan }
  | {
    kind: 'plan-proposed';
    tasks: PlanMeetingTask[];
    brief?: {
      goal: string;
      approach?: string;
      steps: Array<{ title: string; detail: string; taskId?: string }>;
      risks: string[];
      openQuestions: string[];
    };
  }
  | { kind: 'decision-pending'; decisionId: string; question: string; path: string; recommendedTitle: string; calendarOk: boolean; remindersOk: boolean }
  | { kind: 'decision-resolved'; decisionId: string; question: string; path: string; conclusion: string }
  | { kind: 'document-saved'; title: string; filename: string; path: string }
  | { kind: 'session-ready' }
  | { kind: 'session-start-failed'; error: string }
  | { kind: 'coordinator-failed'; hostId: string; candidateHostId: string | null; error?: string }
  | {
      kind: 'coordinator-review-stalled';
      reviewId: string;
      deliveryId: string;
      taskId?: string;
      reason: 'review-turn-budget-exhausted' | 'coordinator-disconnected' | 'user-required';
      uncoveredChunkIds: string[];
      remainingChunks: number;
    };

export type EmittedEvent = SessionEvent | OrchestratorOnlyEvent;

export interface OrchestratorEvent {
  source: OrchestratorSource;
  event: EmittedEvent;
  /** Host group that produced this event. Defaults to 'default' when absent.
   *  Added in the multi-host phase so the renderer can route events to the
   *  correct HostGroupState slot. */
  hostId?: string;
}

export interface TalkerTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export interface WorkerLiveStatus {
  lastAssistantText: string;
  currentTool: string | null;
  currentToolInput: string | null;
  lastUpdateTs: number;
  busy: boolean;
}

export interface WorkerTaskHistoryEntry {
  id: string;
  title: string;
  status: WorkerStatusKind;
  startedAt: number;
  finishedAt: number;
  summary?: string;
}

export interface WorkerHandle {
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  supersedesTaskId?: string;
  executorBackendId?: string;
  writePaths?: string[];
  executionProfile?: PlanMeetingTask['executionProfile'];
  contextSelection?: PlanMeetingTask['contextSelection'];
  workspaceMode?: PlanMeetingTask['workspaceMode'];
  authorityRequest?: PlanMeetingTask['authorityRequest'];
  budget: NonNullable<PlanMeetingTask['budget']>;
  budgetAttempts: TaskBudgetAttempt[];
  budgetPauseReason?: string;
  contextPackage?: import('./task-collaboration.js').ContextPackage;
  contextPackageHash?: string;
  backendRuntime?: import('./backends/task-profile.js').BackendRuntime;
  effectiveProfile?: import('./task-collaboration.js').BackendEffectiveProfile;
  authorityGrant?: import('./task-collaboration.js').TaskAuthorityGrant;
  approvalDecisionId?: string;
  approvalRecordedAt?: number;
  approvedPlanVersion?: number;
  acceptanceCriteria?: import('./worker-protocol.js').AcceptanceCriterion[];
  status: WorkerStatusKind;
  session: BackendSession | null;
  /** Last durable native conversation handle. Captured before interruption so
   * a user-approved continuation can resume without replaying side effects. */
  backendSession?: BackendSessionSnapshot;
  summary: string;
  live: WorkerLiveStatus;
  pendingDelegateAck: boolean;
  queuedAddenda: string[];
  bufferedUpdates: string[];
  flushTimer: NodeJS.Timeout | null;
  specialty: WorkerSpecialtyKind;
  startedAt: number;
  currentTaskId: string;
  taskSeq: number;
  taskHistory: WorkerTaskHistoryEntry[];
  /** Files this worker has written/edited during the CURRENT task. Snapshotted
   *  and cleared by `markTaskDone` to emit a `worker-delivery` event. Reset on
   *  `reassignWorker` when the same handle picks up a new task. */
  deliveries: Set<string>;
  /** Explicitly submitted deliverables via `submit_delivery` tool. When non-empty,
   *  these override the auto-tracked `deliveries` set. Workers use this to declare
   *  final artifacts (documents, code) rather than letting the system include
   *  intermediate scripts and temp files. */
  explicitDeliveries: string[];
  workspace: TaskWorkspace | null;
  workspaceDiagnostic?: WorkspaceBlockedDiagnostic;
  backendId: string;
  attempt: number;
  eventSeq: number;
  report: WorkReport | null;
  transportEnded: boolean;
  /** One invalid-report signal is followed by the provider's reportless turn
   * completion. Suppress only that paired boundary after the durable protocol
   * correction has been queued; a second invalid or missing report still
   * fails closed. */
  suppressNextReportlessCompletion: boolean;
  deliveryId: string | null;
  emittedCandidateId?: string;
  acceptedFinalized?: boolean;
  /** B1 stall watchdog: set true once a `worker-stalled` event has fired for
   *  the current idle stretch, cleared on the next activity (lastUpdateTs bump)
   *  so each distinct stall is announced exactly once, not every sweep tick. */
  stallNotified: boolean;
  /** First stall fires a nudge to the worker; only escalate to the user on
   *  the second consecutive stall (meaning the nudge didn't unblock it). */
  stallNudged: boolean;
  /** Timestamp the handle entered its current parked (slot-holding,
   *  non-running) delivery status, so sweepStalls can alert / fail-closed
   *  long-stuck parkers. Undefined while running / pending / terminal. */
  parkedSinceTs?: number;
  /** One-shot alert latch for a parked stretch, mirroring stallNotified. */
  parkedNotified?: boolean;
  /** Consecutive identical authority hard-denies. After the streak limit the
   *  attempt terminates as failed/blocked instead of burning the token budget. */
  authorityDenyStreak: number;
  lastAuthorityDenyReason?: string;
  /** Targets the user approved by hand during this attempt. Consulted only for
   *  remediable authority misses so the same directory/command/host stops
   *  asking; dropped whenever the attempt or its grant changes. */
  authorityAddendum?: import('./task-authority.js').TaskAuthorityAddendum;
  /** Canonical requests currently waiting on a user decision, keyed by native
   *  request id, so an approval can be folded into the addendum. */
  pendingAuthorityAsks?: Map<string, import('./backends/canonical-execution.js').CanonicalExecutionRequest>;
}

export interface RecentFileEdit {
  workerId: string;
  ts: number;
}
