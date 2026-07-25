import assert from 'node:assert/strict';
import test from 'node:test';

import { DeliveryHarness } from '../dist-electron/delivery-harness.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

const report = {
  status: 'completed',
  summary: 'implemented and tested',
  files: [{ path: 'src/result.ts', action: 'modified' }],
  tests: [{ command: 'npm test', status: 'passed', summary: 'all green' }],
  unresolved: [],
};

async function waitFor(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('dependency is released only after journal-shaped delivery acceptance', async () => {
  const events = [];
  const sessions = [];
  const workspaceInputs = [];
  let integrationHead;
  let releaseJournalFlush;
  let flushStarted = false;
  const journalFlush = new Promise((resolve) => {
    releaseJournalFlush = resolve;
  });
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify() { return { passed: true, checks: [{ id: 'tests' }] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: {
      async integrate() {
        integrationHead = 'accepted-integration-head';
        return {
          kind: 'meeting-branch',
          sourceRevision: 'base-revision',
          resultRevision: integrationHead,
          workspace: process.cwd(),
        };
      },
    },
  });
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
    meetingId: 'meeting-slice',
    defaultBackendId: 'opencode',
    deliveryHarness: harness,
    getIntegrationHead() { return integrationHead; },
    workspaceManager: {
      inspectBaseline() {
        return {
          kind: 'git-clean',
          revision: 'base-revision',
          changedPaths: [],
          untrackedPaths: [],
          truncated: false,
        };
      },
      preparationBlock() { return null; },
      canPrepare() { return true; },
      prepare(taskId, input) {
        workspaceInputs.push({ taskId, input });
        return {
          kind: input.mode,
          cwd: process.cwd(),
          sourceRevision: input.sourceRevision ?? 'base-revision',
          lockKeys: [],
          baseline: this.inspectBaseline(),
          managed: true,
        };
      },
      release() {},
    },
    async flushEvents() {
      flushStarted = true;
      await journalFlush;
    },
  });

  assert.deepEqual(scheduler.installPlan([
    {
      id: 'first',
      title: 'OpenCode task',
      prompt: 'implement it',
      deps: [],
      executorBackendId: 'opencode',
      acceptanceCriteria: [{
        id: 'tests',
        description: 'Tests pass',
        verification: { kind: 'manual' },
      }],
    },
    {
      id: 'dependent',
      title: 'Dependent task',
      prompt: 'consume it',
      deps: ['first'],
      executorBackendId: 'opencode',
    },
  ]), { ok: true });

  await waitFor(() => sessions.length === 1, 'first worker was not spawned');
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: 'working' } });
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });

  const ready = await waitFor(
    () => events.map((item) => item.event)
      .find((event) => event.kind === 'delivery-status'
        && event.delivery.status === 'awaiting-delivery-acceptance'),
    'delivery did not reach review acceptance',
  );
  const deliveryBriefing = await waitFor(
    () => events.map((item) => item.event)
      .find((event) => event.kind === 'coordinator-briefing'
        && event.briefing.kind === 'delivery-ready'),
    'delivery-ready briefing was not emitted',
  );
  assert.equal(deliveryBriefing.briefing.files, 1);
  assert.equal(deliveryBriefing.briefing.testsPassed, 1);
  assert.equal(deliveryBriefing.briefing.recommendedAction, 'review');
  assert.equal(sessions.length, 1, 'reviewed is not accepted and must not release dependencies');

  const workerEvents = events.map((item) => item.event)
    .filter((event) => event.kind === 'worker-event')
    .map((event) => event.event);
  assert.deepEqual(workerEvents.map((event) => event.seq), [1, 2, 3]);
  assert.ok(workerEvents.every((event) => (
    event.schemaVersion === 2
    && event.meetingId === 'meeting-slice'
    && event.backendId === 'opencode'
    && event.attempt === 1
  )));

  const acceptance = scheduler.acceptDelivery(ready.delivery.id, ready.delivery.candidate.id);
  await waitFor(() => flushStarted, 'acceptance did not wait for the journal');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessions.length, 1, 'dependency started before accepted state was durable');
  releaseJournalFlush();
  await acceptance;
  await waitFor(() => sessions.length === 2, 'accepted delivery did not release dependent task');
  const plan = events.map((item) => item.event)
    .filter((event) => event.kind === 'plan-updated')
    .at(-1).plan;
  assert.equal(plan.nodes.find((node) => node.id === 'first').status, 'accepted');
  assert.equal(plan.nodes.find((node) => node.id === 'dependent').status, 'running');
  assert.equal(
    workspaceInputs.find((entry) => entry.taskId === 'dependent').input.sourceRevision,
    'accepted-integration-head',
    'dependent task must start from the durably accepted Meeting integration head',
  );
  scheduler.endAll();
});

test('capacity saturation pauses new work and sends one structured coordinator briefing', async () => {
  const events = [];
  const sessions = [];
  const coordinatorInputs = [];
  const scheduler = new WorkerScheduler({
    emit(event) { events.push(event); },
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        async start() {},
        sendUserText() {},
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
        end() {},
      };
      sessions.push(session);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() {
      return { sendUserText(text) { coordinatorInputs.push(text); } };
    },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    meetingId: 'meeting-capacity',
  });
  const tasks = Array.from({ length: 6 }, (_, index) => ({
    id: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    prompt: `do task ${index + 1}`,
    deps: [],
  }));
  assert.deepEqual(scheduler.installPlan(tasks), { ok: true });
  await waitFor(() => sessions.length === 4, 'scheduler did not fill the four worker slots');

  const capacityBriefings = events.map((event) => event.event)
    .filter((event) => event.kind === 'coordinator-briefing'
      && event.briefing.kind === 'capacity');
  assert.equal(capacityBriefings.length, 1);
  assert.deepEqual(capacityBriefings[0].briefing.capacity, {
    running: 4,
    limit: 4,
    waiting: 2,
  });
  assert.equal(
    coordinatorInputs.some((text) => text.startsWith('[structured coordinator briefing]')),
    true,
  );
  scheduler.endAll();
});

test('parked awaiting-acceptance releases the concurrency slot for pending work', async () => {
  const sessions = [];
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify() { return { passed: true, checks: [{ id: 'tests' }] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: {
      async integrate() {
        return {
          kind: 'meeting-branch',
          sourceRevision: 'base',
          resultRevision: 'integrated',
          workspace: process.cwd(),
        };
      },
    },
  });
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        ended: false,
        async start() {},
        sendUserText() {},
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
        end() { this.ended = true; },
      };
      sessions.push(session);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    meetingId: 'meeting-parked-slot',
    deliveryHarness: harness,
  });
  const tasks = Array.from({ length: 5 }, (_, index) => ({
    id: `slot-${index + 1}`,
    title: `Slot ${index + 1}`,
    prompt: `do slot ${index + 1}`,
    deps: [],
    acceptanceCriteria: [{
      id: 'manual',
      description: 'Host accepts',
      verification: { kind: 'manual' },
    }],
  }));
  assert.deepEqual(scheduler.installPlan(tasks), { ok: true });
  await waitFor(() => sessions.length === 4, 'four worker slots were not filled');

  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'slot-1')?.status === 'awaiting-acceptance',
    'first worker did not park in awaiting-acceptance',
  );
  assert.equal(sessions[0].ended, true, 'parked worker must end its Backend session');
  await waitFor(() => sessions.length === 5, 'freed slot did not start the fifth pending worker');
  assert.equal(
    scheduler.snapshot().find((task) => task.id === 'slot-5')?.status,
    'running',
  );
  scheduler.endAll();
});

test('dependencyGate reviewed releases dependents before user acceptance', async () => {
  const sessions = [];
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify() { return { passed: true, checks: [{ id: 'tests' }] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: {
      async integrate() {
        return {
          kind: 'meeting-branch',
          sourceRevision: 'base',
          resultRevision: 'integrated',
          workspace: process.cwd(),
        };
      },
    },
  });
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        async start() {},
        sendUserText() {},
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
    meetingId: 'meeting-reviewed-gate',
    deliveryHarness: harness,
  });

  assert.deepEqual(scheduler.installPlan([
    {
      id: 'analysis',
      title: 'Analysis',
      prompt: 'inspect and report',
      deps: [],
      dependencyGate: 'reviewed',
      acceptanceCriteria: [{
        id: 'manual',
        description: 'Host accepts',
        verification: { kind: 'manual' },
      }],
    },
    {
      id: 'follow-on',
      title: 'Follow on',
      prompt: 'use the analysis',
      deps: ['analysis'],
    },
  ]), { ok: true });

  await waitFor(() => sessions.length === 1, 'analysis worker did not start');
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'analysis')?.status === 'awaiting-acceptance',
    'analysis did not reach awaiting-acceptance',
  );
  await waitFor(() => sessions.length === 2, 'reviewed gate did not release the dependent');
  assert.equal(
    scheduler.snapshot().find((task) => task.id === 'follow-on')?.status,
    'running',
  );
  assert.equal(
    scheduler.snapshot().find((task) => task.id === 'analysis')?.status,
    'awaiting-acceptance',
    'reviewed gate must not invent acceptance',
  );
  scheduler.endAll();
});

test('freeze-deferred Accept cannot open the accepted dependency gate', async () => {
  const sessions = [];
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify() { return { passed: true, checks: [{ id: 'tests' }] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: {
      async integrate() {
        return {
          kind: 'meeting-branch',
          sourceRevision: 'base',
          resultRevision: 'integrated',
          workspace: process.cwd(),
        };
      },
    },
    candidatePreparer: {
      async prepare() {
        throw new Error('worktree contains unreported changes: package.json');
      },
    },
    reviewDriver: {
      async request() {
        throw new Error('review driver must not run when freeze fails');
      },
    },
  });
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        async start() {},
        sendUserText() {},
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
    meetingId: 'meeting-freeze-gate',
    deliveryHarness: harness,
    workspaceManager: {
      inspectBaseline() {
        return {
          kind: 'git-clean',
          revision: 'base-revision',
          changedPaths: [],
          untrackedPaths: [],
          truncated: false,
        };
      },
      preparationBlock() { return null; },
      canPrepare() { return true; },
      prepare(_taskId, input) {
        return {
          kind: input.mode,
          cwd: process.cwd(),
          sourceRevision: 'base-revision',
          lockKeys: [],
          baseline: this.inspectBaseline(),
          managed: true,
        };
      },
      release() {},
    },
  });

  assert.deepEqual(scheduler.installPlan([
    {
      id: 'writer',
      title: 'Writer',
      prompt: 'change code',
      deps: [],
      dependencyGate: 'accepted',
      writePaths: ['src'],
      workspaceMode: 'git-worktree',
      acceptanceCriteria: [{
        id: 'tests',
        description: 'Tests pass',
        verification: { kind: 'manual' },
      }],
    },
    {
      id: 'follow-on',
      title: 'Follow on',
      prompt: 'use writer output',
      deps: ['writer'],
      writePaths: ['src'],
      workspaceMode: 'git-worktree',
    },
  ]), { ok: true });

  await waitFor(() => sessions.length === 1, 'writer did not start');
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'writer')?.status === 'awaiting-acceptance',
    'writer did not park after freeze deferral',
  );
  const writer = scheduler.snapshot().find((task) => task.id === 'writer');
  const delivery = writer.delivery;
  assert.equal(delivery?.candidate?.freezeDeferred, true);

  await assert.rejects(
    () => scheduler.acceptDelivery(delivery.id, delivery.candidate.id),
    /freeze was deferred|Meeting branch/,
  );
  assert.equal(
    scheduler.snapshot().find((task) => task.id === 'follow-on')?.status,
    'pending',
    'accepted gate must stay closed without Meeting-branch staging',
  );
  assert.equal(sessions.length, 1);
  scheduler.endAll();
});

test('reviewed gate stays closed during coordinator-reviewing', async () => {
  const sessions = [];
  let resolveReview;
  const reviewRequested = new Promise((resolve) => { resolveReview = resolve; });
  const frozenFixture = (await import('./fixtures/coordinator-review-candidate.json', {
    with: { type: 'json' },
  })).default;
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify() { return { passed: true, checks: [{ id: 'tests' }] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: {
      async integrate() {
        return {
          kind: 'meeting-branch',
          sourceRevision: 'base',
          resultRevision: 'integrated',
          workspace: process.cwd(),
        };
      },
    },
    candidatePreparer: {
      async prepare(order) {
        const frozen = structuredClone(frozenFixture);
        frozen.deliveryId = order.deliveryId;
        frozen.attempt = order.attempt;
        frozen.taskId = order.taskId;
        frozen.workspace = order.workspace;
        frozen.baseRevision = order.sourceRevision;
        return frozen;
      },
    },
    reviewDriver: {
      async request(input) {
        resolveReview(input);
        return {
          id: 'review-1',
          deliveryId: input.candidate.deliveryId,
          candidateId: input.candidate.id,
          reviewHash: input.candidate.diffHash,
          status: 'active',
        };
      },
    },
  });
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        async start() {},
        sendUserText() {},
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
    meetingId: 'meeting-coord-review-gate',
    deliveryHarness: harness,
    workspaceManager: {
      inspectBaseline() {
        return {
          kind: 'git-clean',
          revision: 'base-revision',
          changedPaths: [],
          untrackedPaths: [],
          truncated: false,
        };
      },
      preparationBlock() { return null; },
      canPrepare() { return true; },
      prepare(_taskId, input) {
        return {
          kind: input.mode,
          cwd: process.cwd(),
          sourceRevision: 'base-revision',
          lockKeys: [],
          baseline: this.inspectBaseline(),
          managed: true,
        };
      },
      release() {},
    },
  });

  assert.deepEqual(scheduler.installPlan([
    {
      id: 'writer',
      title: 'Writer',
      prompt: 'change code',
      deps: [],
      dependencyGate: 'reviewed',
      writePaths: ['src'],
      workspaceMode: 'git-worktree',
      acceptanceCriteria: [{
        id: 'tests',
        description: 'Tests pass',
        verification: { kind: 'manual' },
      }],
    },
    {
      id: 'follow-on',
      title: 'Follow on',
      prompt: 'use writer output',
      deps: ['writer'],
      writePaths: ['src'],
      workspaceMode: 'git-worktree',
    },
  ]), { ok: true });

  await waitFor(() => sessions.length === 1, 'writer did not start');
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  await reviewRequested;
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'writer')?.status === 'coordinator-reviewing',
    'writer did not enter coordinator-reviewing',
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    scheduler.snapshot().find((task) => task.id === 'follow-on')?.status,
    'pending',
    'reviewed gate must not release during coordinator-reviewing',
  );
  assert.equal(sessions.length, 1);
  scheduler.endAll();
});
