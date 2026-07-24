// Single source of truth for the in-proc MCP tools the Talker uses to drive
// Workers. Both sides need these names — the orchestrator registers them
// (electron) and the renderer filters them out of the user-facing activity
// feed (src/hooks/useClaude.ts).
import { z } from 'zod';
import { acceptanceCriterionSchema, workReportSchema } from './worker-protocol.js';
import { taskExecutionProfileSchema } from './task-collaboration.js';

export const MEETING_TOOLS = {
  DELEGATE: 'delegate_task',
  UPDATE: 'update_task',
  STATUS: 'ask_worker_status',
  NARRATE: 'narrate_to_user',
  PLAN_MEETING: 'plan_meeting',
  DELEGATE_TO: 'delegate_to',
  TASK_DONE: 'task_done',
  SUBMIT_WORK_REPORT: 'submit_work_report',
  SUBMIT_DELIVERY: 'submit_delivery',
  REQUEST_DECISION: 'request_user_decision',
  ASK_HOST: 'ask_host',
  REPLY_COORDINATOR: 'reply_to_coordinator',
} as const;

export type MeetingToolName = (typeof MEETING_TOOLS)[keyof typeof MEETING_TOOLS];

export const MEETING_TOOL_NAMES: ReadonlySet<string> = new Set<string>(
  Object.values(MEETING_TOOLS),
);

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
  prompt: z.string().min(1).describe('The full prompt the worker will receive as its first message.'),
  deps: z.array(z.string()).optional().describe('IDs of tasks that must finish before this one starts.'),
  executorBackendId: z.string().min(1).optional().describe('CLI backend that should execute this task. Defaults to the meeting coordinator backend.'),
  writePaths: z.array(z.string().min(1)).max(100).optional().describe('Expected output paths, used for non-Git workspace locking.'),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).max(100).optional()
    .describe('User-approved verification criteria. Legacy tasks without criteria receive one explicit manual criterion.'),
  requiresDecision: z.boolean().optional()
    .describe('Whether the Coordinator expects this task may need a user decision before completion.'),
};

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
  diagnostic?: 'legacy-plan-task-normalized';
}

/** Compile one legacy/current plan input into the strict collaboration shape.
 * Defaults are deliberately non-executable beyond scoped reads and declared
 * workspace writes: no command, network, environment or external authority is
 * inferred. */
export function normalizePlanMeetingTask(
  input: unknown,
  defaultBackendId: string,
): NormalizedPlanMeetingTask {
  const legacy = planMeetingTaskInputSchema.parse(input);
  if (
    legacy.executionProfile
    && legacy.executorBackendId
    && legacy.executionProfile.backendId !== legacy.executorBackendId
  ) {
    throw new Error('executorBackendId must match executionProfile.backendId');
  }
  const backendId = legacy.executorBackendId
    ?? legacy.executionProfile?.backendId
    ?? defaultBackendId.trim();
  if (!backendId) throw new Error('plan task requires a default execution Backend');
  const writePaths = legacy.authorityRequest?.writePaths
    ?? legacy.writePaths
    ?? [];
  const contextMode = legacy.executionProfile?.contextMode ?? 'meeting-summary';
  const normalized = planMeetingTaskSchema.parse({
    ...legacy,
    deps: legacy.deps ?? [],
    executorBackendId: backendId,
    writePaths,
    executionProfile: legacy.executionProfile ?? {
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
    workspaceMode: legacy.workspaceMode ?? (writePaths.length > 0 ? 'git-worktree' : 'read-only'),
    authorityRequest: legacy.authorityRequest ?? {
      writePaths,
      toolKinds: writePaths.length > 0 ? ['read', 'write'] : ['read'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
  });
  const wasLegacy = legacy.executionProfile === undefined
    || legacy.contextSelection === undefined
    || legacy.workspaceMode === undefined
    || legacy.authorityRequest === undefined;
  return {
    task: normalized,
    ...(wasLegacy ? { diagnostic: 'legacy-plan-task-normalized' as const } : {}),
  };
}

export function normalizePlanMeetingTasks(
  inputs: readonly unknown[],
  defaultBackendId: string,
): { tasks: PlanMeetingTask[]; diagnostics: string[] } {
  const normalized = inputs.map((input) => normalizePlanMeetingTask(input, defaultBackendId));
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
  };
}

export const planMeetingArgsSchema = {
  tasks: z.array(planMeetingTaskInputSchema).min(1).describe('One task per independent piece of work.'),
};

export const delegateToArgsSchema = {
  workerId: z.string().min(1).describe('The id of the worker to steer.'),
  addendum: z.string().min(1).describe('Additional instruction or context for that worker.'),
};

export const askHostArgsSchema = {
  hostId: z.string().min(1).max(64),
  question: z.string().min(1).max(20_000),
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

export function validatePlan(tasks: PlanMeetingTask[]): PlanValidationError | null {
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
  for (const task of tasks) {
    for (const dep of task.deps ?? []) {
      if (!ids.has(dep)) {
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
