// Single source of truth for the in-proc MCP tools the Talker uses to drive
// Workers. Both sides need these names — the orchestrator registers them
// (electron) and the renderer filters them out of the user-facing activity
// feed (src/hooks/useClaude.ts).
import { z } from 'zod';
import { acceptanceCriterionSchema, workReportSchema } from './worker-protocol.js';
import { taskExecutionProfileSchema } from './task-collaboration.js';
import { DEFAULT_TASK_BUDGET, taskBudgetSchema } from './task-budget.js';
import { applyTaskDispatchDefaults, inferDefaultDependencyGate } from './task-intent.js';

export { MEETING_TOOLS, MEETING_TOOL_NAMES } from './meeting-tool-names.js';
export type { MeetingToolName } from './meeting-tool-names.js';

const taskContextSelectionSchema = z.object({
  mode: taskExecutionProfileSchema.shape.contextMode,
  messageIds: z.array(z.string().trim().min(1).max(500)).max(500).default([]),
  decisionIds: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  dependencyTaskIds: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  attachmentIds: z.array(z.string().trim().min(1).max(500)).max(100).default([]),
}).strict();

const taskAuthorityRequestSchema = z.object({
  writePaths: z.array(z.string().trim().min(1).max(4_096)).max(100),
  toolKinds: z.array(z.string().trim().min(1).max(200)).max(100),
  workingDirectories: z.array(z.string().trim().min(1).max(4_096)).max(100),
  commands: z.array(z.array(z.string().max(4_000)).min(1).max(100)).max(100),
  environmentKeys: z.array(z.string().trim().min(1).max(200)).max(100),
  maxCommandTimeoutMs: z.number().int().min(1_000).max(7_200_000),
  networkHosts: z.array(z.string().trim().min(1).max(253)).max(100),
}).strict();

const planMeetingTaskBaseShape = {
  id: z.string().min(1).describe('Stable kebab-case identifier for the task.'),
  title: z.string().min(1).describe('Short label shown on the worker tile.'),
  prompt: z.string().min(1).describe(
    'Detailed worker brief: goal, context, concrete steps, files/areas to touch, '
    + 'out-of-scope, and how to verify. Not a one-liner.',
  ),
  deps: z.array(z.string()).optional().describe('IDs of tasks that must finish before this one starts.'),
  executorBackendId: z.string().min(1).optional().describe('CLI backend that should execute this task. Defaults to the meeting coordinator backend.'),
  writePaths: z.array(z.string().min(1)).max(100).optional().describe('Expected output paths, used for non-Git workspace locking.'),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100).optional()
    .describe('User-approved verification criteria. Legacy tasks without criteria receive one explicit manual criterion.'),
  dependencyGate: z.enum(['reviewed', 'accepted']).optional()
    .describe(
      'When dependents may start. "reviewed" releases after verification+review; '
      + '"accepted" (default) waits for durable user acceptance and integration.',
    ),
  requiresDecision: z.boolean().optional()
    .describe('Whether the Coordinator expects this task may need a user decision before completion.'),
  budget: taskBudgetSchema.optional()
    .describe('User-visible aggregate attempt, token, duration and stagnation limits.'),
  priority: z.number().optional()
    .describe('Dispatch priority, -10..10 (default 0). Higher runs earlier when slots are contended; out-of-range values are clamped.'),
};

/** Human-readable plan document shown before the ops/task DAG. */
export const meetingPlanStepSchema = z.object({
  title: z.string().trim().min(1).max(200)
    .describe('Step title in the plan (what happens in this phase).'),
  detail: z.string().trim().min(1).max(20_000)
    .describe('Why this step, what changes, and how we know it worked.'),
  taskId: z.string().trim().min(1).max(64).optional()
    .describe('Optional link to the worker task that implements this step.'),
}).strict();

export const meetingPlanBriefInputSchema = z.object({
  goal: z.string().trim().min(1).max(4_000).optional()
    .describe('Plan overview: what success looks like for the user.'),
  approach: z.string().trim().min(1).max(20_000).optional()
    .describe('Approach and rationale: architecture, trade-offs, sequencing.'),
  steps: z.array(meetingPlanStepSchema).max(50).optional()
    .describe('Ordered plan steps the host can read before approving.'),
  risks: z.array(z.string().trim().min(1).max(2_000)).max(20).optional()
    .describe('Risks, unknowns, or blast radius.'),
  openQuestions: z.array(z.string().trim().min(1).max(2_000)).max(20).optional()
    .describe('Questions that do not block starting, but the host should see.'),
}).strict();

export type MeetingPlanStep = z.infer<typeof meetingPlanStepSchema>;
export type MeetingPlanBriefInput = z.infer<typeof meetingPlanBriefInputSchema>;

export interface MeetingPlanBrief {
  goal: string;
  approach?: string;
  steps: MeetingPlanStep[];
  risks: string[];
  openQuestions: string[];
}

/** Fill a readable plan brief even when the Talker only sent bare tasks. */
export function normalizeMeetingPlanBrief(
  input: MeetingPlanBriefInput | undefined,
  tasks: Array<{ id: string; title: string; prompt: string }>,
): MeetingPlanBrief {
  const goal = input?.goal?.trim()
    || (tasks.length === 1
      ? tasks[0]!.title
      : `完成 ${tasks.length} 项协作任务：${tasks.map((task) => task.title).join('、')}`);
  const steps = input?.steps && input.steps.length > 0
    ? input.steps.map((step) => ({
      title: step.title.trim(),
      detail: step.detail.trim(),
      ...(step.taskId ? { taskId: step.taskId.trim() } : {}),
    }))
    : tasks.map((task) => ({
      title: task.title,
      detail: task.prompt.length > 600 ? `${task.prompt.slice(0, 600)}…` : task.prompt,
      taskId: task.id,
    }));
  return {
    goal,
    ...(input?.approach?.trim() ? { approach: input.approach.trim() } : {}),
    steps,
    risks: (input?.risks ?? []).map((item) => item.trim()).filter(Boolean),
    openQuestions: (input?.openQuestions ?? []).map((item) => item.trim()).filter(Boolean),
  };
}

/** Boundary-only compatibility input. It remains permissive about fields that
 * did not exist before collaboration schema v1, but still rejects unknown
 * properties. Call normalizePlanMeetingTask before scheduling it. */
export const planMeetingTaskInputSchema = z.object({
  ...planMeetingTaskBaseShape,
  executionProfile: taskExecutionProfileSchema.optional(),
  contextSelection: taskContextSelectionSchema.optional(),
  workspaceMode: z.enum(['read-only', 'git-worktree', 'shared-locked']).optional(),
  authorityRequest: taskAuthorityRequestSchema.optional(),
}).strict();

export type PlanMeetingTaskInput = z.infer<typeof planMeetingTaskInputSchema>;

export const planMeetingTaskSchema = z.object({
  ...planMeetingTaskBaseShape,
  priority: z.number().int().min(-10).max(10).default(0),
  budget: taskBudgetSchema,
  dependencyGate: z.enum(['reviewed', 'accepted']).default('accepted'),
  executionProfile: taskExecutionProfileSchema,
  contextSelection: taskContextSelectionSchema,
  workspaceMode: z.enum(['read-only', 'git-worktree', 'shared-locked']),
  authorityRequest: taskAuthorityRequestSchema,
}).strict().superRefine((value, ctx) => {
  if (
    value.executorBackendId !== undefined
    && value.executorBackendId !== value.executionProfile.backendId
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'executorBackendId must match executionProfile.backendId',
      path: ['executorBackendId'],
    });
  }
  if (value.contextSelection.mode !== value.executionProfile.contextMode) {
    ctx.addIssue({
      code: 'custom',
      message: 'contextSelection.mode must match executionProfile.contextMode',
      path: ['contextSelection', 'mode'],
    });
  }
  if (
    value.workspaceMode === 'read-only'
    && (
      value.authorityRequest.writePaths.length > 0
      || value.authorityRequest.commands.length > 0
      || value.authorityRequest.environmentKeys.length > 0
      || value.authorityRequest.networkHosts.length > 0
      || value.authorityRequest.toolKinds.some((kind) => !['read', 'search', 'git-read'].includes(kind))
    )
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'read-only tasks cannot request write, command, network, environment, or external authority',
      path: ['workspaceMode'],
    });
  }
});

export type PlanMeetingTask = z.infer<typeof planMeetingTaskSchema>;

export interface NormalizedPlanMeetingTask {
  task: PlanMeetingTask;
  diagnostic?: 'legacy-plan-task-normalized' | 'intent-defaults-applied';
  /** Authority the runtime filled in, phrased for the Talker and the Tasks
   *  panel so an auto-dispatched task is never a black box. */
  appliedDefaults?: string[];
}

/** Per-task record of runtime-filled authority, aggregated for one plan. */
export interface AppliedTaskDefaults {
  taskId: string;
  notes: string[];
}

export interface NormalizePlanMeetingOptions {
  /** Workspace cwd for detecting test runners (package.json, go.mod, …). */
  cwd?: string;
  /** When set, inferred writers prefer shared-locked off clean git. */
  baselineKind?: 'git-clean' | 'git-dirty' | 'non-git';
}

/** Compile one legacy/current plan input into the strict collaboration shape.
 * Defaults are deliberately non-executable beyond scoped reads and declared
 * workspace writes: no command, network, environment or external authority is
 * inferred. */
function sameArgv(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function isCommandToolKind(kind: string): boolean {
  return ['command', 'bash', 'execute', 'exec', 'shell', 'terminal'].includes(kind.trim().toLowerCase());
}

function isNetworkToolKind(kind: string): boolean {
  return ['network', 'fetch', 'web'].includes(kind.trim().toLowerCase());
}

/** Writer / execute / network envelopes must match the declared grants.
 *  Talkers often set `workspaceMode: 'shared-locked'` without writePaths, or
 *  list acceptance command criteria without `commands`/`toolKinds` — workers
 *  then burn budget on hard authority denials. */
function coerceTaskAuthority(
  workspaceMode: 'read-only' | 'git-worktree' | 'shared-locked',
  writePaths: string[],
  authority: {
    writePaths: string[];
    toolKinds: string[];
    workingDirectories: string[];
    commands: string[][];
    environmentKeys: string[];
    maxCommandTimeoutMs: number;
    networkHosts: string[];
  },
  acceptanceCriteria: Array<{
    verification: { kind: 'manual' } | { kind: 'command'; argv: string[] };
  }> | undefined,
): typeof authority {
  const isWriter = workspaceMode === 'git-worktree' || workspaceMode === 'shared-locked';
  const paths = writePaths.length > 0 ? writePaths : authority.writePaths;
  if (isWriter && paths.length === 0) {
    throw new Error(
      `${workspaceMode} tasks must declare writePaths (e.g. [".vibe-assets/ping.txt"]); `
      + 'otherwise Write/Edit are denied as tool-kind-not-granted',
    );
  }

  const commands = authority.commands.map((argv) => [...argv]);
  for (const criterion of acceptanceCriteria ?? []) {
    if (criterion.verification.kind !== 'command') continue;
    const argv = [...criterion.verification.argv];
    if (!commands.some((existing) => sameArgv(existing, argv))) {
      commands.push(argv);
    }
  }

  const toolKinds = [...authority.toolKinds];
  if (paths.length > 0 && !toolKinds.includes('write')) {
    toolKinds.push('write');
  }
  if (commands.length > 0 && !toolKinds.some(isCommandToolKind)) {
    toolKinds.push('command');
  }
  if (authority.networkHosts.length > 0 && !toolKinds.some(isNetworkToolKind)) {
    toolKinds.push('network');
  }
  if (!toolKinds.includes('read')) {
    toolKinds.unshift('read');
  }

  if (toolKinds.some(isCommandToolKind) && commands.length === 0) {
    throw new Error(
      'tasks that grant command/execute toolKinds must declare commands '
      + '(exact argv allowlist, e.g. [["npm","test"]]); otherwise Bash is denied as command-not-granted',
    );
  }
  if (toolKinds.some(isNetworkToolKind) && authority.networkHosts.length === 0) {
    throw new Error(
      'tasks that grant network toolKinds must declare networkHosts; '
      + 'otherwise network tools are denied as network-host-not-granted',
    );
  }

  return {
    ...authority,
    writePaths: paths,
    toolKinds,
    commands,
  };
}

/** Dirty / non-git baselines cannot allocate managed worktrees. Coerce writers
 *  to shared-locked before install so tasks do not sit pending forever. */
export function coerceWorkspaceModeForBaseline(
  workspaceMode: 'read-only' | 'git-worktree' | 'shared-locked',
  baselineKind: 'git-clean' | 'git-dirty' | 'non-git',
): 'read-only' | 'git-worktree' | 'shared-locked' {
  if (workspaceMode === 'git-worktree' && baselineKind !== 'git-clean') {
    return 'shared-locked';
  }
  return workspaceMode;
}

export function normalizePlanMeetingTask(
  input: unknown,
  defaultBackendId: string,
  options: NormalizePlanMeetingOptions = {},
): NormalizedPlanMeetingTask {
  const legacy = planMeetingTaskInputSchema.parse(input);
  if (
    legacy.executionProfile
    && legacy.executorBackendId
    && legacy.executionProfile.backendId !== legacy.executorBackendId
  ) {
    throw new Error('executorBackendId must match executionProfile.backendId');
  }
  // Workers are forced to the TUI backend. Ignore any executorBackendId the
  // host may have set in plan_meeting; defaultBackendId comes from
  // resolveDefaultWorkerBackendId which forces 'claude-code-terminal' (or
  // falls back to the host backend if terminal is unavailable, so validation
  // surfaces a clear error instead of silently running headless).
  const backendId = defaultBackendId.trim();
  if (!backendId) throw new Error('plan task requires a default execution Backend');

  const declaredWritePaths = legacy.authorityRequest?.writePaths
    ?? legacy.writePaths
    ?? [];
  const declaredCommands = legacy.authorityRequest?.commands ?? [];
  const defaults = applyTaskDispatchDefaults({
    id: legacy.id,
    title: legacy.title,
    prompt: legacy.prompt,
    writePaths: declaredWritePaths,
    workspaceMode: legacy.workspaceMode,
    commands: declaredCommands,
    cwd: options.cwd,
    baselineKind: options.baselineKind,
  });

  const writePaths = defaults.writePaths ?? declaredWritePaths;
  const contextMode = legacy.executionProfile?.contextMode ?? 'meeting-summary';
  const workspaceMode = defaults.workspaceMode
    ?? legacy.workspaceMode
    ?? (writePaths.length > 0 ? 'git-worktree' : 'read-only');
  const inferredCommands = defaults.commands ?? declaredCommands;
  const baseAuthority = legacy.authorityRequest
    ? {
        ...legacy.authorityRequest,
        writePaths: legacy.authorityRequest.writePaths.length > 0
          ? legacy.authorityRequest.writePaths
          : writePaths,
        commands: legacy.authorityRequest.commands.length > 0
          ? legacy.authorityRequest.commands
          : inferredCommands,
      }
    : {
        writePaths,
        toolKinds: writePaths.length > 0 ? ['read', 'write'] : ['read'],
        workingDirectories: ['.'],
        commands: inferredCommands,
        environmentKeys: [],
        maxCommandTimeoutMs: 1_800_000,
        networkHosts: [],
      };
  const authorityRequest = coerceTaskAuthority(
    workspaceMode,
    writePaths,
    baseAuthority,
    legacy.acceptanceCriteria,
  );
  const inferredGate = inferDefaultDependencyGate({
    workspaceMode,
    writePaths: authorityRequest.writePaths,
    title: legacy.title,
    prompt: legacy.prompt,
  });
  const dependencyGate = legacy.dependencyGate ?? inferredGate;
  // Clamp instead of reject: an out-of-range priority from the Talker should
  // degrade gracefully, never invalidate the whole plan.
  const priority = Math.max(-10, Math.min(10, Math.round(legacy.priority ?? 0)));
  const gateNotes = [...(defaults.notes ?? [])];
  if (legacy.dependencyGate === undefined && dependencyGate === 'reviewed') {
    gateNotes.push('dependency gate reviewed (analysis / read-only)');
  }
  const normalized = planMeetingTaskSchema.parse({
    ...legacy,
    deps: legacy.deps ?? [],
    executorBackendId: backendId,
    writePaths: authorityRequest.writePaths,
    executionProfile: legacy.executionProfile
      ? { ...legacy.executionProfile, backendId }
      : {
          schemaVersion: 1,
          backendId,
          workMode: 'balanced',
          contextMode,
          timeoutMs: 1_800_000,
          maxTokenBudget: 200_000,
        },
    contextSelection: legacy.contextSelection ?? {
      mode: contextMode,
      messageIds: [],
      decisionIds: [],
      dependencyTaskIds: [],
      attachmentIds: [],
    },
    workspaceMode,
    authorityRequest,
    budget: legacy.budget ?? DEFAULT_TASK_BUDGET,
    dependencyGate,
    priority,
  });
  const wasLegacy = legacy.executionProfile === undefined
    || legacy.contextSelection === undefined
    || legacy.workspaceMode === undefined
    || legacy.authorityRequest === undefined
    || legacy.budget === undefined
    || legacy.dependencyGate === undefined;
  const diagnostic = defaults.diagnostic
    ?? (wasLegacy ? 'legacy-plan-task-normalized' as const : undefined);
  return {
    task: normalized,
    ...(diagnostic ? { diagnostic } : {}),
    ...(gateNotes.length ? { appliedDefaults: gateNotes } : {}),
  };
}

export function normalizePlanMeetingTasks(
  inputs: readonly unknown[],
  defaultBackendId: string,
  options: NormalizePlanMeetingOptions = {},
): {
  tasks: PlanMeetingTask[];
  diagnostics: string[];
  appliedDefaults: AppliedTaskDefaults[];
} {
  const normalized = inputs.map((input) => normalizePlanMeetingTask(input, defaultBackendId, options));
  const tasks = normalized.map((entry) => entry.task);
  const hasManagedWriter = tasks.some((task) => (
    task.workspaceMode === 'git-worktree' && task.authorityRequest.writePaths.length > 0
  ));
  const hasCompatibilityWriter = tasks.some((task) => (
    task.workspaceMode === 'shared-locked' && task.authorityRequest.writePaths.length > 0
  ));
  if (hasManagedWriter && hasCompatibilityWriter) {
    throw new Error(
      'a Meeting plan cannot mix managed git-worktree writers with shared-locked compatibility writers',
    );
  }
  return {
    tasks,
    diagnostics: normalized.flatMap((entry) => entry.diagnostic ? [entry.diagnostic] : []),
    appliedDefaults: normalized.flatMap((entry, index) => (
      entry.appliedDefaults?.length
        ? [{ taskId: tasks[index].id, notes: entry.appliedDefaults }]
        : []
    )),
  };
}

export const planMeetingArgsSchema = {
  goal: meetingPlanBriefInputSchema.shape.goal,
  approach: meetingPlanBriefInputSchema.shape.approach,
  steps: meetingPlanBriefInputSchema.shape.steps,
  risks: meetingPlanBriefInputSchema.shape.risks,
  openQuestions: meetingPlanBriefInputSchema.shape.openQuestions,
  tasks: z.array(planMeetingTaskInputSchema).min(1)
    .describe('Worker DAG implementing the plan. Each task prompt must be a full brief.'),
};

export const delegateToArgsSchema = {
  workerId: z.string().min(1).describe('The id of the worker to steer.'),
  addendum: z.string().min(1).describe('Additional instruction or context for that worker.'),
};

export const taskMessageArgsSchema = {
  taskId: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(100_000),
  executorBackendId: z.string().trim().min(1).max(64).optional()
    .describe('Optional backend override; only applies when the message starts a fresh attempt (task no longer running).'),
};

export const interruptTaskArgsSchema = {
  taskId: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(20_000).optional(),
};

export const forwardTaskMessageArgsSchema = {
  fromTaskId: z.string().trim().min(1).max(64),
  toTaskId: z.string().trim().min(1).max(64),
  messageId: z.string().trim().min(1).max(500),
};

const coordinatorReviewFindingSchema = z.object({
  code: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(4_000),
  blocking: z.boolean(),
  path: z.string().trim().min(1).max(4_096).optional(),
}).strict();

export const inspectDeliveryReviewArgsSchema = {
  reviewId: z.string().trim().min(1).max(500),
};

export const getDeliveryReviewChunkArgsSchema = {
  reviewId: z.string().trim().min(1).max(500),
  chunkId: z.string().trim().min(1).max(500).optional(),
};

export const submitDeliveryChunkReviewArgsSchema = {
  reviewId: z.string().trim().min(1).max(500),
  chunkId: z.string().trim().min(1).max(500),
  chunkHash: z.string().regex(/^[a-f0-9]{64}$/u),
  verdict: z.enum(['passed', 'blocking']),
  findings: z.array(coordinatorReviewFindingSchema).max(100),
};

export const completeDeliveryReviewArgsSchema = {
  reviewId: z.string().trim().min(1).max(500),
};

export const requestDeliveryReworkArgsSchema = {
  reviewId: z.string().trim().min(1).max(500),
  findings: z.array(coordinatorReviewFindingSchema).min(1).max(100),
  executorBackendId: z.string().trim().min(1).max(64).optional()
    .describe('Optional backend override for the rework attempt. The provider session cannot be resumed across backends, so the new attempt starts fresh.'),
};

export const askHostArgsSchema = {
  hostId: z.string().min(1).max(64),
  question: z.string().min(1).max(20_000),
};

/** Observed-session tools: `id` comes from observed_sessions_list (exact or
 *  unique ≥4-char prefix); `targetDescription` is the one-sentence window
 *  summary shown on the user's approval card, e.g. 「向 ahakeyconfig 的
 *  Kimi 窗口发送输入」. */
export const observedSessionActionArgsSchema = {
  id: z.string().trim().min(1).max(64)
    .describe('Session id from observed_sessions_list (exact, or a unique prefix of at least 4 chars).'),
  targetDescription: z.string().trim().min(1).max(200)
    .describe('One-sentence target description shown on the approval card, e.g. 「向 ahakeyconfig 的 Kimi 窗口发送输入」.'),
};

export const observedSessionSendTextArgsSchema = {
  ...observedSessionActionArgsSchema,
  text: z.string().min(1).max(1_000)
    .describe('Text to type into the terminal; exactly one Return is appended. To approve a waiting permission prompt, send "y" or "1".'),
};

export const taskDoneArgsSchema = {
  summary: z.string().min(1).describe('One-line summary of what changed; surfaced to Talker context.'),
};

export const submitWorkReportArgsSchema = {
  report: workReportSchema.describe('Complete, provider-neutral WorkReport for the current task.'),
};

export const submitDeliveryArgsSchema = {
  files: z.array(z.string().min(1)).min(1).describe('Absolute paths to the final deliverable files (documents, code, etc.) that the user should review. Use this to explicitly declare what you are delivering for acceptance.'),
};

export const decisionOptionSchema = z.object({
  title: z.string().min(1).describe('Short label for this option.'),
  summary: z.string().min(1).describe('One-paragraph explanation of what this option entails.'),
  pros: z.array(z.string()).default([]).describe('Bullet-list of upsides.'),
  cons: z.array(z.string()).default([]).describe('Bullet-list of downsides or risks.'),
  recommendationScore: z.number().int().min(1).max(10).describe('1-10 rating; higher means more strongly recommended.'),
});

export type DecisionOptionInput = z.infer<typeof decisionOptionSchema>;

export const requestDecisionArgsSchema = {
  question: z.string().min(1).describe('Short question shown as the doc title and Calendar/Reminders title (e.g. "用方案 A 还是方案 B？").'),
  context: z.string().optional().describe('Optional background; pasted into the markdown doc under the question.'),
  options: z.array(decisionOptionSchema).min(2).describe('All viable options the user could pick, ranked best-on-top by recommendationScore.'),
  deadlineMs: z.number().int().positive().describe('Epoch ms. Used for the Calendar event start time + Reminders due date. Pick something reasonable based on urgency (e.g. now + 1 day for non-urgent, +30 min for blocking decisions).'),
};

export interface PlanValidationError {
  code: 'duplicate_id' | 'unknown_dep' | 'cycle' | 'empty' | 'workspace_mode_mix';
  message: string;
}

export function validatePlan(
  tasks: PlanMeetingTask[],
  options?: { knownDependencyIds?: ReadonlySet<string> },
): PlanValidationError | null {
  if (tasks.length === 0) {
    return { code: 'empty', message: 'Plan must contain at least one task.' };
  }
  const hasManagedWriter = tasks.some((task) => (
    task.workspaceMode === 'git-worktree' && task.authorityRequest.writePaths.length > 0
  ));
  const hasCompatibilityWriter = tasks.some((task) => (
    task.workspaceMode === 'shared-locked' && task.authorityRequest.writePaths.length > 0
  ));
  if (hasManagedWriter && hasCompatibilityWriter) {
    return {
      code: 'workspace_mode_mix',
      message: 'a Meeting plan cannot mix managed git-worktree writers with shared-locked compatibility writers',
    };
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      return { code: 'duplicate_id', message: `Duplicate task id: ${task.id}` };
    }
    ids.add(task.id);
  }
  const knownDeps = options?.knownDependencyIds ?? new Set<string>();
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      if (!ids.has(dep) && !knownDeps.has(dep)) {
        return { code: 'unknown_dep', message: `Task ${task.id} depends on unknown task ${dep}` };
      }
      if (dep === task.id) {
        return { code: 'cycle', message: `Task ${task.id} depends on itself` };
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const task of tasks) adjacency.set(task.id, task.deps ?? []);

  function visit(id: string): PlanValidationError | null {
    if (visited.has(id)) return null;
    if (visiting.has(id)) {
      return { code: 'cycle', message: `Cycle detected involving task ${id}` };
    }
    visiting.add(id);
    for (const dep of adjacency.get(id) ?? []) {
      const err = visit(dep);
      if (err) return err;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const task of tasks) {
    const err = visit(task.id);
    if (err) return err;
  }
  return null;
}
