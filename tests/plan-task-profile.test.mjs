import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePlanMeetingTask,
  normalizePlanMeetingTasks,
  planMeetingTaskSchema,
} from '../dist-electron/meeting-tools.js';

const profile = {
  schemaVersion: 1,
  backendId: 'codex',
  workMode: 'balanced',
  contextMode: 'meeting-summary',
  timeoutMs: 1_800_000,
  maxTokenBudget: 200_000,
};

function currentTask(overrides = {}) {
  return {
    id: 'task-login',
    title: 'Fix login',
    prompt: 'Fix login validation.',
    deps: [],
    executorBackendId: 'codex',
    writePaths: ['src/auth'],
    executionProfile: profile,
    contextSelection: {
      mode: 'meeting-summary',
      messageIds: [],
      decisionIds: [],
      dependencyTaskIds: [],
      attachmentIds: [],
    },
    workspaceMode: 'git-worktree',
    authorityRequest: {
      writePaths: ['src/auth'],
      toolKinds: ['read', 'write'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
    ...overrides,
  };
}

test('strict executable tasks require a complete execution profile and authority request', () => {
  assert.equal(planMeetingTaskSchema.safeParse(currentTask()).success, true);
  const { executionProfile: _profile, ...withoutProfile } = currentTask();
  assert.equal(planMeetingTaskSchema.safeParse(withoutProfile).success, false);
  assert.equal(planMeetingTaskSchema.safeParse({
    ...currentTask(),
    executorBackendId: 'opencode',
  }).success, false);
  assert.equal(planMeetingTaskSchema.safeParse({
    ...currentTask(),
    unknown: true,
  }).success, false);
});

test('legacy plan tasks normalize with conservative non-command authority', () => {
  const normalized = normalizePlanMeetingTask({
    id: 'legacy',
    title: 'Legacy task',
    prompt: 'Update the documentation.',
    deps: [],
    executorBackendId: 'opencode',
    writePaths: ['docs'],
  }, 'claude-code');

  assert.equal(normalized.diagnostic, 'legacy-plan-task-normalized');
  assert.equal(normalized.task.executionProfile.backendId, 'opencode');
  assert.equal(normalized.task.executionProfile.workMode, 'balanced');
  assert.equal(normalized.task.workspaceMode, 'git-worktree');
  assert.deepEqual(normalized.task.authorityRequest, {
    writePaths: ['docs'],
    toolKinds: ['read', 'write'],
    workingDirectories: ['.'],
    commands: [],
    environmentKeys: [],
    maxCommandTimeoutMs: 1_800_000,
    networkHosts: [],
  });
});

test('read-only legacy recovery never gains write, command, network, or environment authority', () => {
  const normalized = normalizePlanMeetingTask({
    id: 'legacy-read',
    title: 'Inspect',
    prompt: 'Inspect the project.',
  }, 'codex').task;

  assert.equal(normalized.workspaceMode, 'read-only');
  assert.deepEqual(normalized.authorityRequest.writePaths, []);
  assert.deepEqual(normalized.authorityRequest.toolKinds, ['read']);
  assert.deepEqual(normalized.authorityRequest.commands, []);
  assert.deepEqual(normalized.authorityRequest.networkHosts, []);
  assert.deepEqual(normalized.authorityRequest.environmentKeys, []);
});

test('read-only current tasks cannot request write authority', () => {
  assert.equal(planMeetingTaskSchema.safeParse(currentTask({
    workspaceMode: 'read-only',
  })).success, false);
});

test('read-only tasks cannot request command, network, environment, or external authority', () => {
  for (const authorityRequest of [
    { ...currentTask().authorityRequest, writePaths: [], toolKinds: ['read', 'execute'] },
    { ...currentTask().authorityRequest, writePaths: [], toolKinds: ['read'], commands: [['npm', 'test']] },
    { ...currentTask().authorityRequest, writePaths: [], toolKinds: ['read'], networkHosts: ['example.com'] },
    { ...currentTask().authorityRequest, writePaths: [], toolKinds: ['read'], environmentKeys: ['TOKEN'] },
  ]) {
    assert.equal(planMeetingTaskSchema.safeParse(currentTask({
      writePaths: [],
      workspaceMode: 'read-only',
      authorityRequest,
    })).success, false);
  }
});

test('managed writer plans cannot mix with shared-locked compatibility writers', () => {
  const compatibility = currentTask({
    id: 'compat',
    workspaceMode: 'shared-locked',
  });
  assert.throws(
    () => normalizePlanMeetingTasks([currentTask(), compatibility], 'codex'),
    /cannot mix managed git-worktree writers with shared-locked compatibility writers/,
  );
  assert.equal(
    normalizePlanMeetingTasks([
      compatibility,
      currentTask({ id: 'reader', writePaths: [], workspaceMode: 'read-only', authorityRequest: {
        ...currentTask().authorityRequest,
        writePaths: [],
        toolKinds: ['read'],
      } }),
    ], 'codex').tasks.length,
    2,
  );
});
