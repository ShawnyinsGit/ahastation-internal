import assert from 'node:assert/strict';
import test from 'node:test';

import { validatePlanDraft } from '../src/lib/plan-validation.ts';

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
  assert.match(validatePlanDraft([task({ executorBackendId: undefined })], [backend]), /缺少执行 Backend/);
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

test('plan validator rejects duplicate ids, unknown dependencies and cycles', () => {
  assert.match(validatePlanDraft([task(), task({ title: 'Duplicate' })], [backend]), /ID 不能重复/);
  assert.match(validatePlanDraft([task({ deps: ['missing'] })], [backend]), /循环或未知/);
  assert.match(validatePlanDraft([
    task({ deps: ['task-b'] }),
    task({ id: 'task-b', title: 'Task B', deps: ['task-a'] }),
  ], [backend]), /循环或未知/);
});
