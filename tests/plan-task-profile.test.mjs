import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePlanMeetingTask,
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
