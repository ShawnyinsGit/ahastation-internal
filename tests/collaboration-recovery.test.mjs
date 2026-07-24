import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessTaskRecovery,
  assertRecoveryActionAllowed,
  normalizeRecoveredTaskStatus,
} from '../dist-electron/task-recovery.js';

function task(overrides = {}) {
  return {
    status: 'running',
    workspaceMode: 'read-only',
    authorityRequest: {
      writePaths: [],
      toolKinds: ['read', 'search', 'git-read'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
    ...overrides,
  };
}

test('only explicit read-only authority is eligible for automatic continuation', () => {
  assert.deepEqual(assessTaskRecovery(task()), {
    schemaVersion: 1,
    classification: 'auto-read-only',
    reasonCode: 'explicit-read-only-authority',
    allowedActions: ['continue-read-only', 'retry-attempt', 'abandon-task'],
    autoResume: true,
  });
  for (const authorityRequest of [
    { ...task().authorityRequest, writePaths: ['src'] },
    { ...task().authorityRequest, commands: [['npm', 'test']] },
    { ...task().authorityRequest, networkHosts: ['example.com'] },
    { ...task().authorityRequest, environmentKeys: ['TOKEN'] },
    { ...task().authorityRequest, toolKinds: ['read', 'external-side-effect'] },
  ]) {
    const assessment = assessTaskRecovery(task({
      workspaceMode: 'git-worktree',
      authorityRequest,
    }));
    assert.equal(assessment.classification, 'requires-user');
    assert.equal(assessment.autoResume, false);
    assert.equal(assessment.allowedActions.includes('continue-read-only'), false);
  }
});

test('legacy and incomplete authority never gains automatic read-only permission', () => {
  assert.equal(assessTaskRecovery({ status: 'running' }).classification, 'requires-user');
  assert.equal(assessTaskRecovery(task({ authorityRequest: undefined })).autoResume, false);
  assert.throws(
    () => assertRecoveryActionAllowed({ status: 'running' }, 'continue-read-only'),
    /not allowed/,
  );
});

test('legacy completion-like states normalize without inventing acceptance evidence', () => {
  assert.equal(normalizeRecoveredTaskStatus('reviewing'), 'interrupted');
  assert.equal(normalizeRecoveredTaskStatus('awaiting-acceptance'), 'interrupted');
  assert.equal(normalizeRecoveredTaskStatus('done'), 'interrupted');
  assert.equal(normalizeRecoveredTaskStatus('accepted'), 'accepted');
  assert.equal(normalizeRecoveredTaskStatus('budget-paused'), 'budget-paused');
  assert.equal(normalizeRecoveredTaskStatus('integration-conflict'), 'integration-conflict');
});

test('integration conflicts require an explicit conflict resolution action', () => {
  const assessment = assessTaskRecovery(task({ status: 'integration-conflict' }));
  assert.equal(assessment.classification, 'integration-conflict');
  assert.deepEqual(assessment.allowedActions, [
    'resolve-integration-conflict',
    'abandon-task',
  ]);
});
