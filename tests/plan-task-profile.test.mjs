import assert from 'node:assert/strict';
import test from 'node:test';

import {
  coerceWorkspaceModeForBaseline,
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

const budget = {
  schemaVersion: 1,
  maxAttempts: 6,
  maxTotalTokens: 600_000,
  maxTotalDurationMs: 14_400_000,
  maxStagnantAttempts: 3,
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
    budget,
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

test('shared-locked without writePaths gets a sandbox when the prompt wants to write', () => {
  const { task } = normalizePlanMeetingTask({
    id: 'ping',
    title: 'Ping',
    prompt: 'Write ping.txt',
    deps: [],
    workspaceMode: 'shared-locked',
  }, 'claude-code');
  assert.deepEqual(task.writePaths, ['.vibe-assets/tasks/ping']);
  assert.equal(task.workspaceMode, 'shared-locked');
});

test('explicit writer mode without writePaths still fails for non-write prompts', () => {
  assert.throws(
    () => normalizePlanMeetingTask({
      id: 'inspect',
      title: 'Inspect',
      prompt: 'Explain the architecture',
      deps: [],
      workspaceMode: 'shared-locked',
    }, 'claude-code'),
    /must declare writePaths/,
  );
});

test('shared-locked with writePaths coerces toolKinds to include write', () => {
  const { task } = normalizePlanMeetingTask({
    id: 'ping',
    title: 'Ping',
    prompt: 'Write .vibe-assets/ping.txt',
    deps: [],
    writePaths: ['.vibe-assets/ping.txt'],
    workspaceMode: 'shared-locked',
    authorityRequest: {
      writePaths: ['.vibe-assets/ping.txt'],
      toolKinds: ['read'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
  }, 'claude-code');
  assert.equal(task.workspaceMode, 'shared-locked');
  assert.ok(task.authorityRequest.toolKinds.includes('write'));
  assert.deepEqual(task.authorityRequest.writePaths, ['.vibe-assets/ping.txt']);
});

test('acceptance command criteria coerce into commands and command toolKinds', () => {
  const { task } = normalizePlanMeetingTask({
    id: 'test-task',
    title: 'Run tests',
    prompt: 'Run the unit tests.',
    deps: [],
    writePaths: ['src'],
    workspaceMode: 'shared-locked',
    acceptanceCriteria: [{
      id: 'unit',
      description: 'npm test passes',
      verification: { kind: 'command', argv: ['npm', 'test'] },
    }],
    authorityRequest: {
      writePaths: ['src'],
      toolKinds: ['read', 'write'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
  }, 'claude-code');
  assert.deepEqual(task.authorityRequest.commands, [['npm', 'test']]);
  assert.ok(task.authorityRequest.toolKinds.includes('command'));
});

test('command toolKinds without commands are rejected', () => {
  assert.throws(
    () => normalizePlanMeetingTask({
      id: 'bad-cmd',
      title: 'Bad',
      prompt: 'Run something',
      deps: [],
      writePaths: ['src'],
      workspaceMode: 'shared-locked',
      authorityRequest: {
        writePaths: ['src'],
        toolKinds: ['read', 'write', 'command'],
        workingDirectories: ['.'],
        commands: [],
        environmentKeys: [],
        maxCommandTimeoutMs: 1_800_000,
        networkHosts: [],
      },
    }, 'claude-code'),
    /must declare commands/,
  );
});

test('network toolKinds without hosts are rejected', () => {
  assert.throws(
    () => normalizePlanMeetingTask({
      id: 'bad-net',
      title: 'Bad',
      prompt: 'Fetch something',
      deps: [],
      writePaths: ['src'],
      workspaceMode: 'shared-locked',
      authorityRequest: {
        writePaths: ['src'],
        toolKinds: ['read', 'write', 'network'],
        workingDirectories: ['.'],
        commands: [],
        environmentKeys: [],
        maxCommandTimeoutMs: 1_800_000,
        networkHosts: [],
      },
    }, 'claude-code'),
    /must declare networkHosts/,
  );
});

test('coerceWorkspaceModeForBaseline downgrades git-worktree off clean git', () => {
  assert.equal(coerceWorkspaceModeForBaseline('git-worktree', 'git-clean'), 'git-worktree');
  assert.equal(coerceWorkspaceModeForBaseline('git-worktree', 'git-dirty'), 'shared-locked');
  assert.equal(coerceWorkspaceModeForBaseline('git-worktree', 'non-git'), 'shared-locked');
  assert.equal(coerceWorkspaceModeForBaseline('read-only', 'non-git'), 'read-only');
});

test('write-intent without writePaths gets a vibe-assets sandbox envelope', () => {
  const { task, diagnostic } = normalizePlanMeetingTask({
    id: 'ping',
    title: 'Ping',
    prompt: '写一句励志短句到文件里',
    deps: [],
  }, 'claude-code', { baselineKind: 'git-dirty' });
  assert.equal(diagnostic, 'intent-defaults-applied');
  assert.deepEqual(task.writePaths, ['.vibe-assets/tasks/ping']);
  assert.equal(task.workspaceMode, 'shared-locked');
  assert.ok(task.authorityRequest.toolKinds.includes('write'));
});

test('test-intent without commands probes package.json for npm test', async (t) => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-plan-intent-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'package.json'), '{"name":"demo"}\n');

  const { task } = normalizePlanMeetingTask({
    id: 'run-tests',
    title: 'Run tests',
    prompt: '跑测试',
    deps: [],
  }, 'claude-code', { cwd, baselineKind: 'git-clean' });
  assert.deepEqual(task.authorityRequest.commands, [['npm', 'test']]);
  assert.ok(task.authorityRequest.toolKinds.includes('command'));
  assert.deepEqual(task.writePaths, ['.vibe-assets/tasks/run-tests']);
});
