// Smoke proof: one meeting, four independent tasks, four Worker backends in
// parallel, canonical WorkerEvent v2 envelopes, and journal/renderer eventId
// parity at the Orchestrator seam.
//
// Run after `npm run build:electron`:
//   node --test --test-timeout=60000 --import "./tests/electron-stub.mjs" tests/multi-backend-worker-smoke.test.mjs

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { DeliveryHarness } from '../dist-electron/delivery-harness.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

const BACKENDS = ['claude-code', 'codex', 'kimi', 'opencode'];

const report = {
  status: 'completed',
  summary: 'parallel smoke slice complete',
  files: [{ path: 'src/smoke.ts', action: 'modified' }],
  tests: [{ command: 'npm test', status: 'passed', summary: 'ok' }],
  unresolved: [],
};

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function makeTrackedSessionFactory() {
  const sessions = [];
  const resolveSessionFactory = (backendId) => (opts) => {
    const session = {
      backendId: backendId ?? 'claude-code',
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
  };
  return { sessions, resolveSessionFactory };
}

function parallelPlan() {
  return BACKENDS.map((backendId, index) => ({
    id: `parallel-${backendId}`,
    title: `${backendId} slice ${index + 1}`,
    prompt: `Execute smoke task for ${backendId}`,
    deps: [],
    executorBackendId: backendId,
    acceptanceCriteria: [{
      id: 'manual',
      description: 'Smoke acceptance',
      verification: { kind: 'manual' },
    }],
  }));
}

function completeWorkerSession(session) {
  session.opts.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: 'working' } });
  session.opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  session.opts.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
}

function workerEventsFrom(events) {
  return events
    .map((entry) => entry.event)
    .filter((event) => event?.kind === 'worker-event')
    .map((event) => event.event);
}

function assertCanonicalWorkerEvents(workerEvents, meetingId) {
  const eventIds = new Set();
  for (const event of workerEvents) {
    assert.equal(event.schemaVersion, 2);
    assert.equal(event.meetingId, meetingId);
    assert.match(event.eventId, /^[0-9a-f-]{36}$/i);
    assert.ok(!eventIds.has(event.eventId), `duplicate eventId ${event.eventId}`);
    eventIds.add(event.eventId);
    assert.ok(BACKENDS.includes(event.backendId), `unexpected backend ${event.backendId}`);
    assert.equal(typeof event.seq, 'number');
    assert.ok(event.seq > 0);
    assert.equal(typeof event.attempt, 'number');
    assert.ok(event.attempt > 0);
  }
  return eventIds;
}

test('one meeting spawns four backend workers in parallel', async () => {
  const events = [];
  const { sessions, resolveSessionFactory } = makeTrackedSessionFactory();
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { async verify() { return { passed: true, checks: [] }; } },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: { async integrate() { return { kind: 'test' }; } },
  });
  const scheduler = new WorkerScheduler({
    emit(event) { events.push(event); },
    cwd: process.cwd(),
    autoApproveScope: 'off',
    resolveSessionFactory,
    sessionFactory: resolveSessionFactory('claude-code'),
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    meetingId: 'meeting-four-backend-parallel',
    defaultBackendId: 'claude-code',
    deliveryHarness: harness,
  });

  assert.deepEqual(scheduler.installPlan(parallelPlan()), { ok: true });
  await waitFor(() => sessions.length === 4, 'four backend workers did not spawn in parallel');

  const spawnedBackends = sessions.map((session) => session.backendId).sort();
  assert.deepEqual(spawnedBackends, [...BACKENDS].sort());
  assert.ok(
    sessions.every((session) => session.inputs.length === 1),
    'each parallel worker received its task prompt',
  );

  for (const session of sessions) completeWorkerSession(session);

  const readyDeliveries = [];
  for (const backendId of BACKENDS) {
    const ready = await waitFor(
      () => events.map((entry) => entry.event).find(
        (event) => event?.kind === 'delivery-status'
          && event.delivery.status === 'awaiting-delivery-acceptance'
          && event.workerId === `parallel-${backendId}`,
      ),
      `delivery for ${backendId} did not reach acceptance`,
    );
    readyDeliveries.push(ready);
  }

  const workerEvents = workerEventsFrom(events);
  assert.ok(workerEvents.length >= 4 * 3, 'expected progress + delivery + ended per worker');
  assertCanonicalWorkerEvents(workerEvents, 'meeting-four-backend-parallel');

  for (const backendId of BACKENDS) {
    const backendEvents = workerEvents.filter((event) => event.backendId === backendId);
    assert.ok(backendEvents.length >= 3, `${backendId} missing canonical worker events`);
    assert.deepEqual(
      backendEvents.map((event) => event.seq),
      backendEvents.map((event) => event.seq).slice().sort((a, b) => a - b),
    );
    assert.equal(backendEvents[0].seq, 1);
    assert.ok(backendEvents.every((event) => event.workerId === `parallel-${backendId}`));
  }

  for (const ready of readyDeliveries) {
    await scheduler.acceptDelivery(ready.delivery.id, ready.delivery.candidate.id);
  }

  const plan = events
    .map((entry) => entry.event)
    .filter((event) => event?.kind === 'plan-updated')
    .at(-1)?.plan;
  assert.ok(plan, 'plan-updated missing after acceptance');
  for (const backendId of BACKENDS) {
    assert.equal(
      plan.nodes.find((node) => node.id === `parallel-${backendId}`)?.status,
      'accepted',
    );
  }

  scheduler.endAll();
});

test('orchestrator keeps renderer worker-eventId identical to events.jsonl', async () => {
  const meetingId = randomUUID();
  const rendererEvents = [];
  const workerSessions = [];
  const orch = new Orchestrator({
    meetingId,
    emit: (event) => { rendererEvents.push(event); },
    cwd: process.cwd(),
    sessionFactory: () => {
      const session = {
        started: false,
        ended: false,
        async start() { this.started = true; },
        sendUserText() {},
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
        end() { this.ended = true; },
      };
      workerSessions.push(session);
      return session;
    },
  });

  assert.deepEqual(await orch.installPlan(parallelPlan()), { ok: true });
  await waitFor(() => workerSessions.length === 4, 'orchestrator did not spawn four workers');

  for (const backendId of BACKENDS) {
    const workerId = `parallel-${backendId}`;
    orch.schedulerOnWorkerEvent(workerId, {
      kind: 'worker-signal',
      signal: { kind: 'progress', message: `${backendId} working` },
    });
    orch.submitWorkerReport(workerId, report);
    orch.schedulerOnWorkerEvent(workerId, {
      kind: 'worker-signal',
      signal: { kind: 'ended', reason: 'completed' },
    });
  }

  await waitFor(
    () => workerEventsFrom(rendererEvents).length >= 12,
    'renderer did not receive canonical worker events',
  );

  const journal = await waitFor(async () => {
    const rows = await MeetingRepository.replay(meetingId);
    return rows.some((row) => row.type === 'event:worker-event') ? rows : null;
  }, 'journal did not persist worker events');

  const rendererWorkerEvents = workerEventsFrom(rendererEvents);
  assertCanonicalWorkerEvents(rendererWorkerEvents, meetingId);

  for (const rendered of rendererWorkerEvents) {
    const journalRow = journal.find((row) => {
      if (row.type !== 'event:worker-event') return false;
      const payload = row.payload;
      return payload?.event?.kind === 'worker-event'
        && payload.event.event?.eventId === rendered.eventId;
    });
    assert.ok(journalRow, `journal missing worker-event ${rendered.eventId}`);
    assert.deepEqual(journalRow.payload.event.event, rendered);
  }

  await orch.end();
});
