import { z } from 'zod';

import { workReportSchema } from './worker-protocol.js';

const idSchema = z.string().trim().min(1).max(500);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.number().int().nonnegative();
const nonEmptyStringSchema = z.string().trim().min(1).max(20_000);

const FORBIDDEN_KEYS = new Set([
  'reasoning',
  'chain_of_thought',
  'hidden_reasoning',
  'api_key',
  'access_token',
  'authorization',
  'credential',
]);

function addForbiddenKeyIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: PropertyKey[] = [],
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => addForbiddenKeyIssues(entry, ctx, [...path, index], seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      ctx.addIssue({
        code: 'custom',
        message: `forbidden key: ${key}`,
        path: [...path, key],
      });
    }
    addForbiddenKeyIssues(entry, ctx, [...path, key], seen);
  }
}

const safeUnknownSchema = z.unknown().superRefine((value, ctx) => {
  addForbiddenKeyIssues(value, ctx);
});

export const taskExecutionProfileSchema = z.object({
  schemaVersion: z.literal(1),
  backendId: z.string().trim().min(1).max(100),
  modelPreference: z.string().trim().min(1).max(200).optional(),
  workMode: z.enum(['fast', 'balanced', 'deep']),
  contextMode: z.enum([
    'minimal',
    'meeting-summary',
    'selected-history',
    'full-visible-history',
  ]),
  timeoutMs: z.number().int().min(30_000).max(7_200_000),
  maxTokenBudget: z.number().int().min(1_000).max(10_000_000),
}).strict();

export type TaskExecutionProfile = z.infer<typeof taskExecutionProfileSchema>;

export const backendEffectiveProfileSchema = z.object({
  schemaVersion: z.literal(1),
  backendId: z.string().trim().min(1).max(100),
  runtimeVersion: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
  nativeReasoning: z.record(z.string(), z.unknown())
    .superRefine((value, ctx) => addForbiddenKeyIssues(value, ctx))
    .optional(),
  unsupported: z.array(z.string().trim().min(1).max(200)).max(100),
  downgraded: z.array(z.string().trim().min(1).max(200)).max(100),
  capabilityHash: hashSchema,
}).strict();

export type BackendEffectiveProfile = z.infer<typeof backendEffectiveProfileSchema>;

const contextMessageSchema = z.object({
  id: idSchema,
  role: z.enum(['user', 'assistant']),
  text: nonEmptyStringSchema,
}).strict();

const contextDecisionSchema = z.object({
  id: idSchema,
  summary: nonEmptyStringSchema,
}).strict();

const dependencyReportSchema = z.object({
  taskId: idSchema,
  reportHash: hashSchema,
  summary: nonEmptyStringSchema,
}).strict();

const contextAttachmentSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(1_000),
  contentHash: hashSchema,
}).strict();

export const contextPackageSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: idSchema,
  attempt: z.number().int().positive(),
  mode: z.enum([
    'minimal',
    'meeting-summary',
    'selected-history',
    'full-visible-history',
  ]),
  messages: z.array(contextMessageSchema).max(10_000),
  decisions: z.array(contextDecisionSchema).max(1_000),
  dependencyReports: z.array(dependencyReportSchema).max(1_000),
  attachments: z.array(contextAttachmentSchema).max(1_000),
  byteLength: z.number().int().nonnegative().max(100_000_000),
  packageHash: hashSchema,
}).strict().superRefine((value, ctx) => addForbiddenKeyIssues(value, ctx));

export type ContextPackage = z.infer<typeof contextPackageSchema>;

export const taskAuthorityGrantSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: idSchema,
  attempt: z.number().int().positive(),
  planVersion: z.number().int().positive(),
  approvalDecisionId: idSchema,
  authorityRequestHash: hashSchema,
  workspaceIdentityHash: hashSchema,
  workspaceRoot: z.string().trim().min(1).max(4_096),
  writePaths: z.array(z.string().trim().min(1).max(4_096)).max(1_000),
  allowedToolKinds: z.array(z.string().trim().min(1).max(200)).max(1_000),
  allowedWorkingDirectories: z.array(z.string().trim().min(1).max(4_096)).max(1_000),
  allowedCommands: z.array(
    z.array(z.string().max(4_000)).min(1).max(100),
  ).max(1_000),
  allowedEnvironmentKeys: z.array(z.string().trim().min(1).max(500)).max(1_000),
  maxCommandTimeoutMs: z.number().int().min(1_000).max(7_200_000),
  allowedNetworkHosts: z.array(z.string().trim().min(1).max(500)).max(1_000),
  approvedAt: timestampSchema,
  expiresAt: timestampSchema,
  grantHash: hashSchema,
}).strict().superRefine((value, ctx) => {
  if (value.expiresAt <= value.approvedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'expiresAt must follow approvedAt',
      path: ['expiresAt'],
    });
  }
});

export type TaskAuthorityGrant = z.infer<typeof taskAuthorityGrantSchema>;

export const taskMessageSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  seq: z.number().int().positive(),
  taskId: idSchema,
  attempt: z.number().int().positive(),
  sender: z.enum(['user', 'coordinator', 'worker', 'system']),
  kind: z.enum([
    'instruction',
    'follow-up',
    'steer',
    'interrupt',
    'status-request',
    'progress',
    'question',
    'approval-request',
    'approval-response',
  ]),
  replyTo: idSchema.optional(),
  payload: safeUnknownSchema,
  status: z.enum(['queued', 'delivered', 'acknowledged', 'failed']),
  timestamp: timestampSchema,
}).strict();

export type TaskMessage = z.infer<typeof taskMessageSchema>;

export const taskWorkspaceSnapshotSchema = z.object({
  kind: z.enum(['read-only', 'git-worktree', 'shared-locked']),
  cwd: z.string().trim().min(1).max(4_096),
  branch: z.string().trim().min(1).max(500).optional(),
  sourceRevision: z.string().trim().min(1).max(500),
  lockKeys: z.array(z.string().trim().min(1).max(4_096)).max(1_000),
  baseline: z.object({
    kind: z.enum(['git-clean', 'git-dirty', 'non-git']),
    revision: z.string().trim().min(1).max(500),
    changedPaths: z.array(z.string().max(4_096)).max(500),
    untrackedPaths: z.array(z.string().max(4_096)).max(500),
    truncated: z.boolean(),
  }).strict().optional(),
  managed: z.boolean().optional(),
  diagnostic: z.enum([
    'dirty-base-visible-read-only',
    'shared-locked-compatibility-only',
  ]).optional(),
}).strict();

export type TaskWorkspaceSnapshot = z.infer<typeof taskWorkspaceSnapshotSchema>;

const verificationCheckSchema = z.object({
  name: z.string().trim().min(1).max(4_000),
  status: z.enum(['passed', 'failed', 'not-run']),
  summary: z.string().trim().max(4_000).optional(),
}).strict();

const taskVerificationSchema = z.object({
  status: z.enum(['passed', 'failed', 'not-run']),
  checks: z.array(verificationCheckSchema).max(1_000),
}).strict();

const reviewCoverageSchema = z.object({
  totalChunks: z.number().int().nonnegative(),
  reviewedChunks: z.number().int().nonnegative(),
  complete: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.reviewedChunks > value.totalChunks) {
    ctx.addIssue({
      code: 'custom',
      message: 'reviewedChunks cannot exceed totalChunks',
      path: ['reviewedChunks'],
    });
  }
  if (value.complete && value.reviewedChunks !== value.totalChunks) {
    ctx.addIssue({
      code: 'custom',
      message: 'complete coverage requires every chunk to be reviewed',
      path: ['complete'],
    });
  }
});

export const taskAttemptRecordSchema = z.object({
  schemaVersion: z.literal(1),
  attempt: z.number().int().positive(),
  backendId: z.string().trim().min(1).max(100),
  backendSessionId: z.string().trim().min(1).max(500).optional(),
  contextPackageHash: hashSchema,
  grantHash: hashSchema,
  baseRevision: z.string().trim().min(1).max(500),
  workspace: taskWorkspaceSnapshotSchema.nullable(),
  messageSeqStart: z.number().int().positive(),
  messageSeqEnd: z.number().int().positive().optional(),
  report: workReportSchema.optional(),
  verification: taskVerificationSchema.optional(),
  reviewCoverage: reviewCoverageSchema.optional(),
  candidateCommit: z.string().trim().min(1).max(500).optional(),
  failureFingerprint: hashSchema.nullable().optional(),
  tokenCost: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.messageSeqEnd !== undefined && value.messageSeqEnd < value.messageSeqStart) {
    ctx.addIssue({
      code: 'custom',
      message: 'messageSeqEnd cannot precede messageSeqStart',
      path: ['messageSeqEnd'],
    });
  }
  if (value.finishedAt !== undefined && value.finishedAt < value.startedAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'finishedAt cannot precede startedAt',
      path: ['finishedAt'],
    });
  }
});

export type TaskAttemptRecord = z.infer<typeof taskAttemptRecordSchema>;

export const MEETING_TASK_STATUSES = [
  'draft',
  'pending',
  'running',
  'verifying',
  'coordinator-reviewing',
  'integration-queued',
  'integrating',
  'accepted',
  'blocked',
  'reworking',
  'integration-conflict',
  'budget-paused',
  'interrupted',
  'failed',
  'cancelled',
] as const;

export const meetingTaskStatusSchema = z.enum(MEETING_TASK_STATUSES);
export type MeetingTaskStatus = z.infer<typeof meetingTaskStatusSchema>;

export const meetingTaskRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  title: z.string().trim().min(1).max(1_000),
  prompt: nonEmptyStringSchema,
  deps: z.array(idSchema).max(1_000),
  status: meetingTaskStatusSchema,
  planVersion: z.number().int().positive(),
  requestedProfile: taskExecutionProfileSchema,
  effectiveProfile: backendEffectiveProfileSchema.optional(),
  contextPackage: contextPackageSchema,
  authorityGrant: taskAuthorityGrantSchema,
  workspace: taskWorkspaceSnapshotSchema.nullable(),
  currentAttempt: z.number().int().positive(),
  attempts: z.array(taskAttemptRecordSchema).max(10_000),
  mailboxCursor: z.number().int().nonnegative(),
  eventCursor: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.contextPackage.taskId !== value.id) {
    ctx.addIssue({
      code: 'custom',
      message: 'context package belongs to a different task',
      path: ['contextPackage', 'taskId'],
    });
  }
  if (value.contextPackage.attempt !== value.currentAttempt) {
    ctx.addIssue({
      code: 'custom',
      message: 'context package attempt does not match currentAttempt',
      path: ['contextPackage', 'attempt'],
    });
  }
  if (value.authorityGrant.taskId !== value.id) {
    ctx.addIssue({
      code: 'custom',
      message: 'authority grant belongs to a different task',
      path: ['authorityGrant', 'taskId'],
    });
  }
  if (value.authorityGrant.attempt !== value.currentAttempt) {
    ctx.addIssue({
      code: 'custom',
      message: 'authority grant attempt does not match currentAttempt',
      path: ['authorityGrant', 'attempt'],
    });
  }
  if (value.authorityGrant.planVersion !== value.planVersion) {
    ctx.addIssue({
      code: 'custom',
      message: 'authority grant planVersion does not match task planVersion',
      path: ['authorityGrant', 'planVersion'],
    });
  }
  const attemptNumbers = new Set(value.attempts.map((entry) => entry.attempt));
  if (attemptNumbers.size !== value.attempts.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'attempt identities must be unique',
      path: ['attempts'],
    });
  }
});

export type MeetingTaskRecord = z.infer<typeof meetingTaskRecordSchema>;

export const legacyDeliveryEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  acceptanceRecorded: z.literal(true),
  integrationRecorded: z.literal(true),
  acceptedAt: timestampSchema,
  integratedRevision: z.string().trim().min(1).max(500),
}).strict();

export type LegacyDeliveryEvidence = z.infer<typeof legacyDeliveryEvidenceSchema>;

type LegacyWorkerStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'awaiting-acceptance'
  | 'reworking'
  | 'accepted'
  | 'interrupted'
  | 'done'
  | 'failed';

const directlyCompatibleStatuses = new Set<MeetingTaskStatus>([
  'pending',
  'running',
  'verifying',
  'reworking',
  'accepted',
  'interrupted',
  'failed',
]);

export function normalizeLegacyWorkerStatus(input: {
  status: LegacyWorkerStatus | string;
  evidence?: LegacyDeliveryEvidence;
}): { status: MeetingTaskStatus; diagnostic?: string } {
  if (directlyCompatibleStatuses.has(input.status as MeetingTaskStatus)) {
    return { status: input.status as MeetingTaskStatus };
  }
  if (input.status === 'done') {
    const evidence = legacyDeliveryEvidenceSchema.safeParse(input.evidence);
    return evidence.success
      ? { status: 'accepted' }
      : { status: 'interrupted', diagnostic: 'legacy-delivery-review-required' };
  }
  if (input.status === 'reviewing' || input.status === 'awaiting-acceptance') {
    return { status: 'interrupted', diagnostic: 'legacy-delivery-review-required' };
  }
  return { status: 'interrupted', diagnostic: 'legacy-status-unknown' };
}
