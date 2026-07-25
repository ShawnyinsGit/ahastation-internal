import assert from 'node:assert/strict';
import test from 'node:test';

import { projectMeetingTasks } from '../dist-electron/task-projection.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'task-a',
    title: 'Task A',
    prompt: 'Do the work.',
    deps: [],
    status: 'pending',
    planVersion: 1,
    requestedProfile: {
      schemaVersion: 1,
      backendId: 'codex',
      workMode: 'balanced',
      contextMode: 'meeting-summary',
      timeoutMs: 1_800_000,
      maxTokenBudget: 200_000,
    },
    effectiveProfile: {
      schemaVersion: 1,
      backendId: 'codex',
      runtimeVersion: '1.0.0',
      model: 'gpt-test',
      unsupported: [],
      downgraded: [],
      capabilityHash: HASH_A,
    },
    contextPackage: {
      schemaVersion: 1,
      taskId: 'task-a',
      attempt: 1,
      mode: 'meeting-summary',
      messages: [],
      decisions: [],
      dependencyReports: [],
      attachments: [],
      byteLength: 0,
      packageHash: HASH_A,
    },
    authorityGrant: {
      schemaVersion: 1,
      taskId: 'task-a',
      attempt: 1,
      planVersion: 1,
      approvalDecisionId: 'decision-1',
      authorityRequestHash: HASH_A,
      workspaceIdentityHash: HASH_B,
      workspaceRoot: 'C:\\workspace',
      writePaths: [],
      allowedToolKinds: ['read'],
      allowedWorkingDirectories: ['C:\\workspace'],
      allowedCommands: [],
      allowedEnvironmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      allowedNetworkHosts: [],
      approvedAt: 1,
      expiresAt: 10_000,
      grantHash: HASH_B,
    },
    workspace: null,
    currentAttempt: 1,
    attempts: [],
    mailboxCursor: 0,
    eventCursor: 0,
    ...overrides,
  };
}

function event(seq, type, data, options = {}) {
  return {
    id: options.id ?? `event-${seq}`,
    seq,
    ts: seq,
    meetingId: 'meeting',
    type,
    payload: {
      schemaVersion: 1,
      taskId: options.taskId ?? 'task-a',
      ...(options.attempt ? { attempt: options.attempt } : {}),
      data,
    },
  };
}

function queuedMessage(seq) {
  return {
    schemaVersion: 1,
    id: `message-${seq}`,
    seq,
    taskId: 'task-a',
    attempt: 1,
    sender: 'coordinator',
    kind: 'instruction',
    payload: { text: `message ${seq}` },
    status: 'queued',
    timestamp: seq,
  };
}

test('projection folds valid task status and mailbox cursors independently', () => {
  const result = projectMeetingTasks([
    event(10, 'task-record-created', record()),
    event(11, 'task-message-enqueued', queuedMessage(1), { attempt: 1 }),
    event(12, 'task-status-changed', { status: 'running' }),
    event(13, 'task-message-delivered', { messageId: 'message-1', messageSeq: 1 }, { attempt: 1 }),
  ]);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.tasks[0].status, 'running');
  assert.equal(result.tasks[0].mailboxCursor, 1);
  assert.equal(result.tasks[0].eventCursor, 13);
  assert.notEqual(result.tasks[0].mailboxCursor, result.tasks[0].eventCursor);
});

test('duplicates are idempotent and impossible transitions become diagnostics', () => {
  const duplicate = event(2, 'task-status-changed', { status: 'running' }, { id: 'same-event' });
  const result = projectMeetingTasks([
    event(1, 'task-record-created', record()),
    duplicate,
    { ...duplicate, seq: 3 },
    event(4, 'task-status-changed', { status: 'accepted' }),
  ]);

  assert.equal(result.tasks[0].status, 'running');
  assert.equal(result.tasks[0].eventCursor, 4);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, 'invalid-transition');
});

test('terminal status rejects late mutation and stale Meeting events', () => {
  const result = projectMeetingTasks([
    event(5, 'task-status-changed', { status: 'running' }),
    event(6, 'task-status-changed', { status: 'verifying' }),
    event(7, 'task-status-changed', { status: 'coordinator-reviewing' }),
    event(8, 'task-status-changed', { status: 'integration-queued' }),
    event(9, 'task-status-changed', { status: 'integrating' }),
    event(10, 'task-status-changed', { status: 'accepted' }),
    event(11, 'task-status-changed', { status: 'failed' }),
  ], [record({ eventCursor: 4 })]);

  assert.equal(result.tasks[0].status, 'accepted');
  assert.equal(result.tasks[0].eventCursor, 11);
  assert.equal(result.diagnostics.at(-1).code, 'invalid-transition');

  const stale = projectMeetingTasks([
    event(3, 'task-status-changed', { status: 'running' }),
  ], [record({ eventCursor: 4 })]);
  assert.equal(stale.diagnostics[0].code, 'stale-event');
});

test('invalid recovery input never throws and yields safe diagnostics', () => {
  const result = projectMeetingTasks([
    {
      id: 'bad-envelope',
      seq: 1,
      ts: 1,
      meetingId: 'meeting',
      type: 'task-status-changed',
      payload: { nativePayload: { secret: 'must not surface' } },
    },
    event(2, 'task-status-changed', { status: 'running' }, { taskId: 'missing' }),
    event(3, 'task-record-created', { ...record(), prompt: '' }),
  ]);

  assert.deepEqual(result.tasks, []);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), [
    'invalid-envelope',
    'unknown-task',
    'invalid-record',
  ]);
  assert.equal(JSON.stringify(result.diagnostics).includes('must not surface'), false);
});
