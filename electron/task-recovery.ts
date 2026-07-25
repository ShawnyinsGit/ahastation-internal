import type { PlanMeetingTask } from './meeting-tools.js';

export const TASK_RECOVERY_ACTIONS = [
  'continue-read-only',
  'continue-side-effecting',
  'retry-attempt',
  'resolve-integration-conflict',
  'abandon-task',
] as const;

export type TaskRecoveryAction = (typeof TASK_RECOVERY_ACTIONS)[number];

export interface TaskRecoveryAssessment {
  schemaVersion: 1;
  classification:
    | 'auto-read-only'
    | 'requires-user'
    | 'integration-conflict'
    | 'budget-paused'
    | 'terminal';
  reasonCode:
    | 'explicit-read-only-authority'
    | 'side-effect-authority'
    | 'legacy-or-incomplete-authority'
    | 'integration-conflict'
    | 'budget-paused'
    | 'terminal';
  allowedActions: TaskRecoveryAction[];
  autoResume: boolean;
}

const READ_ONLY_TOOL_KINDS = new Set(['read', 'search', 'git-read']);
const TERMINAL_TASK_STATUSES = new Set(['accepted', 'failed', 'cancelled']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function commandList(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/** Conservative legacy status normalization. Historical `done`,
 * `reviewing`, and `awaiting-acceptance` records prove neither complete
 * Coordinator review nor durable integration, so recovery never upgrades
 * them to accepted. */
export function normalizeRecoveredTaskStatus(status: unknown): string {
  if (status === 'accepted' || status === 'failed' || status === 'cancelled') {
    return status;
  }
  if (status === 'budget-paused') return status;
  if (status === 'integration-conflict') return status;
  return 'interrupted';
}

export function normalizeLegacyTaskStatus(status: unknown): unknown {
  return status === 'reviewing'
    || status === 'awaiting-acceptance'
    || status === 'done'
    ? 'interrupted'
    : status;
}

/** Return true only when the persisted plan explicitly proves a task has no
 * write, command, environment, network, credential, or external authority.
 * Missing legacy facts are never interpreted as read-only permission. */
export function isExplicitReadOnlyRecoveryTask(task: Record<string, unknown>): boolean {
  if (task.workspaceMode !== 'read-only') return false;
  const authority = record(task.authorityRequest);
  if (!authority) return false;
  const writePaths = strings(authority.writePaths);
  const toolKinds = strings(authority.toolKinds);
  const commands = commandList(authority.commands);
  const environmentKeys = strings(authority.environmentKeys);
  const networkHosts = strings(authority.networkHosts);
  if (
    !writePaths
    || !toolKinds
    || !commands
    || !environmentKeys
    || !networkHosts
  ) return false;
  return writePaths.length === 0
    && commands.length === 0
    && environmentKeys.length === 0
    && networkHosts.length === 0
    && toolKinds.every((kind) => READ_ONLY_TOOL_KINDS.has(kind));
}

export function assessTaskRecovery(task: Record<string, unknown>): TaskRecoveryAssessment {
  const status = normalizeRecoveredTaskStatus(task.status);
  if (TERMINAL_TASK_STATUSES.has(status)) {
    return {
      schemaVersion: 1,
      classification: 'terminal',
      reasonCode: 'terminal',
      allowedActions: [],
      autoResume: false,
    };
  }
  if (status === 'budget-paused') {
    return {
      schemaVersion: 1,
      classification: 'budget-paused',
      reasonCode: 'budget-paused',
      allowedActions: ['abandon-task'],
      autoResume: false,
    };
  }
  if (status === 'integration-conflict') {
    return {
      schemaVersion: 1,
      classification: 'integration-conflict',
      reasonCode: 'integration-conflict',
      allowedActions: ['resolve-integration-conflict', 'abandon-task'],
      autoResume: false,
    };
  }
  if (isExplicitReadOnlyRecoveryTask(task)) {
    return {
      schemaVersion: 1,
      classification: 'auto-read-only',
      reasonCode: 'explicit-read-only-authority',
      allowedActions: ['continue-read-only', 'retry-attempt', 'abandon-task'],
      autoResume: true,
    };
  }
  const authority = record(task.authorityRequest);
  return {
    schemaVersion: 1,
    classification: 'requires-user',
    reasonCode: authority ? 'side-effect-authority' : 'legacy-or-incomplete-authority',
    allowedActions: ['continue-side-effecting', 'retry-attempt', 'abandon-task'],
    autoResume: false,
  };
}

export function assertRecoveryActionAllowed(
  task: Record<string, unknown>,
  action: TaskRecoveryAction,
): TaskRecoveryAssessment {
  const assessment = assessTaskRecovery(task);
  if (!assessment.allowedActions.includes(action)) {
    throw new Error(
      `recovery action ${action} is not allowed for ${assessment.classification}`,
    );
  }
  return assessment;
}

export function recoveryRecordFromPlanTask(
  task: PlanMeetingTask,
  status: string,
): Record<string, unknown> {
  return {
    status,
    workspaceMode: task.workspaceMode,
    authorityRequest: structuredClone(task.authorityRequest),
  };
}
