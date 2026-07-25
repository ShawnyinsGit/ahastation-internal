import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePlanDrafts, validatePlanDraft } from '../src/lib/plan-validation.ts';

const backend = {
  id: 'opencode',
  displayName: 'OpenCode',
  supportsWorkers: true,
  available: true,
  loggedIn: true,
  hasApiKey: false,
  authMode: 'oauth',
  isDefault: true,
};

function task(overrides = {}) {
  return {
    id: 'task-a',
    title: 'Task A',
    prompt: 'Do the work',
    deps: [],
    executorBackendId: 'opencode',
    acceptanceCriteria: [{
      id: 'tests',
      description: 'Tests pass',
      verification: { kind: 'command', argv: ['npm', 'test'] },
    }],
    ...overrides,
  };
}

test('plan validator accepts a runnable task with backend and machine criteria', () => {
  assert.equal(validatePlanDraft([task()], [backend]), null);
});

test('plan validator rejects unavailable backend, empty criteria and command argv', () => {
  assert.match(validatePlanDraft([task()], [{ ...backend, supportsWorkers: false }]), /Backend 当前不可用/);
  assert.match(validatePlanDraft([task({ executorBackendId: 'missing' })], [backend]), /执行 Backend 不存在/);
  assert.match(validatePlanDraft([task({ acceptanceCriteria: [] })], [backend]), /缺少验收条件/);
  assert.match(validatePlanDraft([task({
    acceptanceCriteria: [{
      id: 'tests',
      description: 'Tests pass',
      verification: { kind: 'command', argv: [] },
    }],
  })], [backend]), /测试命令不能为空/);
});

test('renderer normalizes legacy drafts with the visible default Backend and safe authority', () => {
  const [normalized] = normalizePlanDrafts([task({
    executorBackendId: undefined,
    writePaths: ['docs'],
  })], [backend]);
  assert.equal(normalized.executorBackendId, 'opencode');
  assert.equal(normalized.executionProfile.backendId, 'opencode');
  assert.equal(normalized.workspaceMode, 'git-worktree');
  assert.equal(normalized.dependencyGate, 'accepted');
  assert.deepEqual(normalized.authorityRequest.commands, []);
  assert.deepEqual(normalized.authorityRequest.networkHosts, []);
});

test('renderer default budget matches electron unlimited ceilings', async () => {
  const { DEFAULT_TASK_BUDGET, isUnlimitedTaskBudget } = await import('../src/lib/task-budget.ts');
  const [normalized] = normalizePlanDrafts([task()], [backend]);
  assert.deepEqual(normalized.budget, DEFAULT_TASK_BUDGET);
  assert.equal(isUnlimitedTaskBudget(normalized.budget), true);
  assert.equal(normalized.budget.maxAttempts, 100);
  assert.notEqual(normalized.budget.maxAttempts, 6);
});

test('renderer preserves an explicit reviewed dependency gate', () => {
  const [normalized] = normalizePlanDrafts([task({
    dependencyGate: 'reviewed',
  })], [backend]);
  assert.equal(normalized.dependencyGate, 'reviewed');
});

test('renderer defaults analysis drafts to reviewed and writers to accepted', () => {
  const [analysis] = normalizePlanDrafts([task({
    title: 'Explain auth',
    prompt: '解释一下登录流程在干什么',
    writePaths: undefined,
    workspaceMode: undefined,
  })], [backend]);
  assert.equal(analysis.workspaceMode, 'read-only');
  assert.equal(analysis.dependencyGate, 'reviewed');

  const [writer] = normalizePlanDrafts([task({
    title: 'Fix login',
    prompt: '修复登录校验',
    writePaths: ['src/auth.ts'],
  })], [backend]);
  assert.equal(writer.dependencyGate, 'accepted');
});

test('dependency gate labels describe Meeting integration, not host Accept click', async () => {
  const {
    dependencyGateShortLabel,
    dependencyGateDetail,
  } = await import('../src/lib/dependency-gate.ts');
  assert.equal(dependencyGateShortLabel('reviewed'), '审查后放行');
  assert.equal(dependencyGateShortLabel('accepted'), '集成后放行');
  assert.equal(dependencyGateShortLabel(undefined), '集成后放行');
  assert.match(dependencyGateDetail('accepted'), /Meeting 集成分支/);
  assert.match(dependencyGateDetail('accepted'), /不能靠点确认放行/);
  assert.match(dependencyGateDetail('reviewed'), /审查进行中|集成冲突不放行/);
});

test('renderer rejects mismatched current execution boundaries', () => {
  assert.match(validatePlanDraft([task({
    executionProfile: {
      schemaVersion: 1,
      backendId: 'codex',
      workMode: 'balanced',
      contextMode: 'meeting-summary',
      timeoutMs: 1_800_000,
      maxTokenBudget: 200_000,
    },
  })], [backend]), /执行 Backend 与执行配置不一致/);
});

test('plan validator rejects duplicate ids, unknown dependencies and cycles', () => {
  assert.match(validatePlanDraft([task(), task({ title: 'Duplicate' })], [backend]), /ID 不能重复/);
  assert.match(validatePlanDraft([task({ deps: ['missing'] })], [backend]), /循环或未知/);
  assert.match(validatePlanDraft([
    task({ deps: ['task-b'] }),
    task({ id: 'task-b', title: 'Task B', deps: ['task-a'] }),
  ], [backend]), /循环或未知/);
});
