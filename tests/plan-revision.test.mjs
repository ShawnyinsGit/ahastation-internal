import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

function createScheduler(overrides = {}) {
  const events = [];
  const sessions = [];
  const messages = new Map();
  const taskMailbox = {
    async enqueue(input) {
      const message = {
        schemaVersion: 1,
        id: `message-${messages.size + 1}`,
        seq: messages.size + 1,
        status: 'queued',
        timestamp: Date.now(),
        ...input,
      };
      messages.set(message.id, message);
      return structuredClone(message);
    },
    async markDelivered(_taskId, messageId) {
      const message = { ...messages.get(messageId), status: 'delivered' };
      messages.set(messageId, message);
      return structuredClone(message);
    },
    async markFailed(_taskId, messageId) {
      const message = { ...messages.get(messageId), status: 'queued' };
      messages.set(messageId, message);
      return structuredClone(message);
    },
    async acknowledge(_taskId, messageId) {
      const message = { ...messages.get(messageId), status: 'acknowledged' };
      messages.set(messageId, message);
      return structuredClone(message);
    },
    get(_taskId, messageId) {
      const message = messages.get(messageId);
      return message ? structuredClone(message) : undefined;
    },
    list(taskId) {
      return Array.from(messages.values()).filter((message) => message.taskId === taskId);
    },
  };
  const scheduler = new WorkerScheduler({
    emit(event) { events.push(event); },
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        inputs: [],
        async start() {},
        sendUserText(text) { this.inputs.push(text); },
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
        end() {},
      };
      sessions.push(session);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    taskMailbox,
    ...overrides,
  });
  return { scheduler, events, sessions, taskMailbox };
}

test('running plans use versioned atomic add, cancel and steer operations', async () => {
  const { scheduler, events, sessions } = createScheduler();
  assert.deepEqual(scheduler.installPlan([
    { id: 'active', title: 'Active', prompt: 'work', deps: [] },
    { id: 'obsolete', title: 'Obsolete', prompt: 'wait', deps: ['active'] },
  ]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.getPlanVersion(), 1);
  assert.equal(sessions.length, 1);

  const result = await scheduler.revisePlan(1, [
    { kind: 'cancel-pending-task', taskId: 'obsolete' },
    {
      kind: 'add-task',
      task: {
        id: 'replacement',
        title: 'Replacement',
        prompt: 'run after active',
        deps: ['active'],
      },
    },
    { kind: 'steer-running-task', taskId: 'active', addendum: 'include the new constraint' },
  ]);
  assert.deepEqual(result, { ok: true, planVersion: 2 });
  await new Promise((resolve) => setImmediate(resolve));

  const plan = events.map((entry) => entry.event)
    .filter((event) => event.kind === 'plan-updated')
    .at(-1).plan;
  assert.equal(plan.version, 2);
  assert.equal(plan.nodes.some((node) => node.id === 'obsolete'), false);
  assert.equal(plan.nodes.some((node) => node.id === 'replacement'), true);
  sessions[0].opts.emit({
    kind: 'message',
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'acknowledged' }] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sessions[0].inputs.some((text) => text.includes('include the new constraint')));
});

test('stale or invalid plan revisions leave the graph unchanged', async () => {
  const { scheduler, events } = createScheduler();
  scheduler.installPlan([
    { id: 'active', title: 'Active', prompt: 'work', deps: [] },
    { id: 'dependent', title: 'Dependent', prompt: 'wait', deps: ['active'] },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  const eventCount = events.length;

  assert.deepEqual(await scheduler.revisePlan(0, [{
    kind: 'add-task',
    task: { id: 'stale', title: 'Stale', prompt: 'must not land', deps: [] },
  }]), {
    ok: false,
    error: 'stale plan version: expected 0, current 1',
  });
  assert.match(
    (await scheduler.revisePlan(1, [{
      kind: 'add-task',
      task: {
        id: 'broken',
        title: 'Broken',
        prompt: 'must not land',
        deps: ['missing'],
      },
    }])).error,
    /depends on unknown/,
  );
  assert.match(
    (await scheduler.revisePlan(1, [{
      kind: 'cancel-pending-task',
      taskId: 'active',
    }])).error,
    /cannot be cancelled while running/,
  );
  assert.match(
    (await scheduler.revisePlan(1, [
      { kind: 'cancel-pending-task', taskId: 'dependent' },
      { kind: 'cancel-pending-task', taskId: 'dependent' },
    ])).error,
    /cancelled more than once/,
  );

  assert.equal(scheduler.getPlanVersion(), 1);
  assert.equal(events.length, eventCount);
  assert.match(scheduler.describeWorkers(), /active/);
  assert.match(scheduler.describeWorkers(), /dependent/);
  assert.doesNotMatch(scheduler.describeWorkers(), /stale/);
});

test('plan revisions may change pending dependencies but not running execution boundaries', async () => {
  const { scheduler } = createScheduler();
  scheduler.installPlan([
    { id: 'active', title: 'Active', prompt: 'work', deps: [] },
    { id: 'pending', title: 'Pending', prompt: 'wait', deps: ['active'] },
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await scheduler.revisePlan(1, [{
    kind: 'update-task',
    taskId: 'pending',
    deps: [],
  }]), { ok: true, planVersion: 2 });

  const activeProfile = {
    schemaVersion: 1,
    backendId: 'codex',
    workMode: 'deep',
    contextMode: 'meeting-summary',
    timeoutMs: 1_800_000,
    maxTokenBudget: 200_000,
  };
  assert.deepEqual(await scheduler.revisePlan(2, [{
    kind: 'update-task',
    taskId: 'active',
    executionProfile: activeProfile,
  }]), {
    ok: false,
    error: 'running task execution boundaries require a new attempt',
  });
  assert.equal(scheduler.getPlanVersion(), 2);
});

test('coordinator cannot switch a pending managed task into shared compatibility mode', async () => {
  const { scheduler } = createScheduler({
    taskAuthorityCompilerRequired: true,
    workspaceManager: {
      inspectBaseline() {
        return {
          kind: 'git-clean',
          revision: 'abc123',
          changedPaths: [],
          untrackedPaths: [],
          truncated: false,
        };
      },
      preparationBlock() { return null; },
      canPrepare() { return false; },
      prepare() { throw new Error('must remain pending'); },
      release() {},
    },
  });
  scheduler.installPlan([
    { id: 'active', title: 'Active', prompt: 'work', deps: [] },
    {
      id: 'pending',
      title: 'Pending writer',
      prompt: 'wait',
      deps: ['active'],
      writePaths: ['src'],
      workspaceMode: 'git-worktree',
    },
  ]);
  assert.deepEqual(await scheduler.revisePlan(1, [{
    kind: 'update-task',
    taskId: 'pending',
    workspaceMode: 'shared-locked',
  }]), {
    ok: false,
    error: 'changing workspace mode requires a new user-approved plan version',
  });
  assert.equal(
    scheduler.snapshot().find((task) => task.id === 'pending').workspaceMode,
    'git-worktree',
  );
});

test('mailbox failure leaves a mixed plan revision graph unchanged', async () => {
  const failingMailbox = {
    async enqueue() { throw new Error('journal unavailable'); },
    async markDelivered() { throw new Error('not reached'); },
    async markFailed() { throw new Error('not reached'); },
    async acknowledge() { throw new Error('not reached'); },
    get() { return undefined; },
    list() { return []; },
  };
  const { scheduler, events } = createScheduler({ taskMailbox: failingMailbox });
  scheduler.installPlan([
    { id: 'active', title: 'Active', prompt: 'work', deps: [] },
    { id: 'obsolete', title: 'Obsolete', prompt: 'wait', deps: ['active'] },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  const eventCount = events.length;

  assert.deepEqual(await scheduler.revisePlan(1, [
    { kind: 'cancel-pending-task', taskId: 'obsolete' },
    { kind: 'steer-running-task', taskId: 'active', addendum: 'new constraint' },
  ]), {
    ok: false,
    error: 'validated steer failed for active: journal unavailable',
  });

  assert.equal(scheduler.getPlanVersion(), 1);
  assert.equal(events.length, eventCount);
  assert.match(scheduler.describeWorkers(), /obsolete/);
});
