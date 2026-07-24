import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEETING_TASK_STATUSES,
  backendEffectiveProfileSchema,
  contextPackageSchema,
  meetingTaskRecordSchema,
  normalizeLegacyWorkerStatus,
  taskAttemptRecordSchema,
  taskAuthorityGrantSchema,
  taskExecutionProfileSchema,
  taskMessageSchema,
} from '../dist-electron/task-collaboration.js';

const HASH = 'a'.repeat(64);
const SECOND_HASH = 'b'.repeat(64);

const requestedProfile = {
  schemaVersion: 1,
  backendId: 'codex',
  workMode: 'balanced',
  contextMode: 'meeting-summary',
  timeoutMs: 1_800_000,
  maxTokenBudget: 200_000,
};

const effectiveProfile = {
  schemaVersion: 1,
  backendId: 'codex',
  runtimeVersion: '1.2.3',
  model: 'gpt-5',
  nativeReasoning: { effort: 'medium' },
  unsupported: [],
  downgraded: [],
  capabilityHash: HASH,
};

const contextPackage = {
  schemaVersion: 1,
  taskId: 'task-login',
  attempt: 1,
  mode: 'meeting-summary',
  messages: [{ id: 'm1', role: 'user', text: 'Fix login and document the authorization flow.' }],
  decisions: [{ id: 'd1', summary: 'Keep existing session storage.' }],
  dependencyReports: [{ taskId: 'task-schema', reportHash: HASH, summary: 'Schema is stable.' }],
  attachments: [{ id: 'a1', name: 'login.png', contentHash: SECOND_HASH }],
  byteLength: 512,
  packageHash: HASH,
};

const authorityGrant = {
  schemaVersion: 1,
  workspaceRoot: 'C:\\work\\project',
  writePaths: ['src/auth'],
  allowedToolKinds: ['read', 'write', 'command'],
  allowedWorkingDirectories: ['.'],
  allowedCommands: [['npm', 'test']],
  allowedEnvironmentKeys: ['CI'],
  maxCommandTimeoutMs: 120_000,
  allowedNetworkHosts: [],
  expiresAt: 1_800_000_000_000,
  grantHash: SECOND_HASH,
};

const attempt = {
  schemaVersion: 1,
  attempt: 1,
  backendId: 'codex',
  backendSessionId: 'session-1',
  contextPackageHash: HASH,
  grantHash: SECOND_HASH,
  baseRevision: 'abc123',
  workspace: {
    kind: 'git-worktree',
    cwd: 'C:\\worktrees\\task-login',
    branch: 'ahastation/meeting/task-login',
    sourceRevision: 'abc123',
    lockKeys: [],
  },
  messageSeqStart: 1,
  messageSeqEnd: 3,
  report: {
    status: 'completed',
    summary: 'Login validation fixed.',
    files: [{ path: 'src/auth/login.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'passed' }],
    unresolved: [],
  },
  verification: {
    status: 'passed',
    checks: [{ name: 'npm test', status: 'passed', summary: '42 tests passed' }],
  },
  reviewCoverage: {
    totalChunks: 2,
    reviewedChunks: 2,
    complete: true,
  },
  candidateCommit: 'def456',
  failureFingerprint: null,
  tokenCost: 12_000,
  durationMs: 45_000,
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_045_000,
};

const record = {
  schemaVersion: 1,
  id: 'task-login',
  title: 'Fix login validation',
  prompt: 'Fix login validation and add tests.',
  deps: [],
  status: 'coordinator-reviewing',
  planVersion: 2,
  requestedProfile,
  effectiveProfile,
  contextPackage,
  authorityGrant,
  workspace: attempt.workspace,
  currentAttempt: 1,
  attempts: [attempt],
  mailboxCursor: 3,
  eventCursor: 12,
};

test('strict collaboration schemas accept the minimum complete record', () => {
  assert.equal(taskExecutionProfileSchema.parse(requestedProfile).backendId, 'codex');
  assert.equal(backendEffectiveProfileSchema.parse(effectiveProfile).model, 'gpt-5');
  assert.equal(contextPackageSchema.parse(contextPackage).messages.length, 1);
  assert.equal(taskAuthorityGrantSchema.parse(authorityGrant).allowedCommands.length, 1);
  assert.equal(taskAttemptRecordSchema.parse(attempt).reviewCoverage.complete, true);
  assert.equal(meetingTaskRecordSchema.parse(record).status, 'coordinator-reviewing');
});

test('every durable task status is accepted', () => {
  assert.deepEqual(MEETING_TASK_STATUSES, [
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
  ]);
  for (const status of MEETING_TASK_STATUSES) {
    assert.equal(meetingTaskRecordSchema.parse({ ...record, status }).status, status);
  }
});

test('strict schemas reject unknown keys and invalid bounds', () => {
  assert.equal(taskExecutionProfileSchema.safeParse({ ...requestedProfile, surprise: true }).success, false);
  assert.equal(taskExecutionProfileSchema.safeParse({ ...requestedProfile, timeoutMs: 1 }).success, false);
  assert.equal(backendEffectiveProfileSchema.safeParse({ ...effectiveProfile, capabilityHash: '' }).success, false);
  assert.equal(contextPackageSchema.safeParse({ ...contextPackage, packageHash: 'not-a-hash' }).success, false);
  assert.equal(taskAuthorityGrantSchema.safeParse({ ...authorityGrant, allowedCommands: [[]] }).success, false);
  assert.equal(taskAttemptRecordSchema.safeParse({ ...attempt, attempt: 0 }).success, false);
  assert.equal(meetingTaskRecordSchema.safeParse({ ...record, mailboxCursor: -1 }).success, false);
});

test('recursive forbidden-key validation rejects secret and hidden-reasoning keys only', () => {
  assert.equal(
    contextPackageSchema.safeParse({
      ...contextPackage,
      messages: [{ id: 'm1', role: 'user', text: 'Document authorization and credential rotation.' }],
    }).success,
    true,
  );
  assert.equal(
    backendEffectiveProfileSchema.safeParse({
      ...effectiveProfile,
      nativeReasoning: { nested: { chain_of_thought: 'secret' } },
    }).success,
    false,
  );
  assert.equal(
    taskMessageSchema.safeParse({
      schemaVersion: 1,
      id: 'msg-1',
      seq: 1,
      taskId: 'task-login',
      attempt: 1,
      sender: 'coordinator',
      kind: 'instruction',
      payload: { nested: { api_key: 'secret' } },
      status: 'queued',
      timestamp: 1,
    }).success,
    false,
  );
});

test('task messages require positive sequence and attempt identity', () => {
  const message = {
    schemaVersion: 1,
    id: 'msg-1',
    seq: 1,
    taskId: 'task-login',
    attempt: 1,
    sender: 'coordinator',
    kind: 'follow-up',
    payload: { text: 'Also cover expired sessions.' },
    status: 'queued',
    timestamp: 1,
  };
  assert.equal(taskMessageSchema.safeParse(message).success, true);
  assert.equal(taskMessageSchema.safeParse({ ...message, seq: 0 }).success, false);
  assert.equal(taskMessageSchema.safeParse({ ...message, attempt: 0 }).success, false);
  assert.equal(taskMessageSchema.safeParse({ ...message, extra: true }).success, false);
});

test('legacy worker statuses normalize without inventing review evidence', () => {
  assert.deepEqual(normalizeLegacyWorkerStatus({ status: 'reviewing' }), {
    status: 'interrupted',
    diagnostic: 'legacy-delivery-review-required',
  });
  assert.deepEqual(normalizeLegacyWorkerStatus({ status: 'awaiting-acceptance' }), {
    status: 'interrupted',
    diagnostic: 'legacy-delivery-review-required',
  });
  assert.deepEqual(normalizeLegacyWorkerStatus({ status: 'done' }), {
    status: 'interrupted',
    diagnostic: 'legacy-delivery-review-required',
  });
  assert.deepEqual(normalizeLegacyWorkerStatus({
    status: 'done',
    evidence: {
      schemaVersion: 1,
      acceptanceRecorded: true,
      integrationRecorded: true,
      acceptedAt: 1_700_000_100_000,
      integratedRevision: 'def456',
    },
  }), { status: 'accepted' });
  assert.deepEqual(normalizeLegacyWorkerStatus({ status: 'running' }), { status: 'running' });
  assert.deepEqual(normalizeLegacyWorkerStatus({ status: 'unknown-status' }), {
    status: 'interrupted',
    diagnostic: 'legacy-status-unknown',
  });
});
