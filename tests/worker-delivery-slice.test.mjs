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
  let releaseJournalFlush;
  let flushStarted = false;
  const journalFlush = new Promise((resolve) => {
    releaseJournalFlush = resolve;
  });
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify() { return { passed: true, checks: [{ id: 'tests' }] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: { async integrate() { return { kind: 'test' }; } },
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
  const deliveryBriefing = events.map((item) => item.event)
    .find((event) => event.kind === 'coordinator-briefing'
      && event.briefing.kind === 'delivery-ready');
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
