// Minimal coverage of the worker-resource-release paths added to fix the
// PTY/subprocess leak. The test stubs ClaudeSession via the Orchestrator's
// `sessionFactory` opt so we never spawn the real Claude CLI subprocess.
//
// Run after `npm run build:electron`:
//   node --test tests/orchestrator-cleanup.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Orchestrator } from '../dist-electron/orchestrator.js';

class FakeSession {
  constructor() {
    this.started = false;
    this.ended = false;
    this.inputs = [];
  }
  start() { this.started = true; }
  sendUserText(text) { this.inputs.push({ kind: 'text', text }); }
  sendUserContent(content) { this.inputs.push({ kind: 'content', content }); }
  resolvePermission() { /* no-op */ }
  async interrupt() { /* no-op */ }
  async setPermissionMode() { /* no-op */ }
  setAutoApprove() { /* no-op */ }
  end() { this.ended = true; }
}

function makeOrch() {
  const events = [];
  const sessions = [];
  const orch = new Orchestrator({
    emit: (e) => events.push(e),
    cwd: '/tmp',
    sessionFactory: () => {
      const s = new FakeSession();
      sessions.push(s);
      return s;
    },
  });
  return { orch, events, sessions };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test('legacy task_done cannot release a worker; accepted WorkReport does', async () => {
  const { orch, sessions, events } = makeOrch();
  const result = await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [] },
  ]);
  assert.equal(result.ok, true);
  await waitUntil(() => sessions.length === 1, 'worker session was not created');
  assert.equal(sessions.length, 1, 'worker session created');
  assert.equal(sessions[0].started, true);
  assert.equal(sessions[0].ended, false, 'session live during task');

  // Legacy completion is only a note. It cannot bypass verification/review.
  orch.markWorkerTaskDone('a', 'finished');
  assert.equal(sessions[0].ended, false, 'task_done cannot release the session');

  orch.submitWorkerReport('a', {
    status: 'completed',
    summary: 'finished with evidence',
    files: [],
    tests: [],
    unresolved: [],
  });
  const ready = await waitUntil(
    () => events.map((entry) => entry.event).find(
      (event) => event?.kind === 'delivery-status'
        && event.delivery.status === 'awaiting-delivery-acceptance',
    ),
    'delivery did not reach user acceptance',
  );
  assert.equal(sessions[0].ended, false, 'review-ready delivery remains live');
  await orch.acceptDelivery(ready.delivery.id, ready.delivery.candidate.id);
  assert.equal(sessions[0].ended, true, 'accepted delivery releases the session');
  await orch.end();
});

test('premature session end (no task_done) cleans up + cascades', async () => {
  const { orch, sessions, events } = makeOrch();
  await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [] },
    { id: 'b', title: 'B', prompt: 'do B', deps: ['a'] },
  ]);
  await waitUntil(() => sessions.length === 1, 'first dependency worker was not created');
  assert.equal(sessions.length, 1, 'only A is spawned initially (B blocked on dep)');

  // Simulate the SDK ending the worker stream before task_done was called
  // (e.g. crash, network drop, or user cancel mid-flight).
  orch.schedulerOnWorkerEvent('a', { kind: 'ended' });
  await waitUntil(
    () => events.filter((e) => e.event?.kind === 'worker-ended' && e.event.status === 'failed').length >= 2,
    'failure did not cascade',
  );

  assert.equal(sessions[0].ended, true, 'A.session.end() invoked on premature end');

  // B should now be marked failed and never spawn.
  const failedEvents = events.filter(
    (e) => e.event && e.event.kind === 'worker-ended' && e.event.status === 'failed',
  );
  const failedIds = failedEvents.map((e) => e.event.workerId).sort();
  assert.deepEqual(failedIds, ['a', 'b'], 'A failed, B cascaded to failed');
  assert.equal(sessions.length, 1, 'B never spawned a session');
  orch.end();
});

test('end() tears down every live worker', async () => {
  const { orch, sessions } = makeOrch();
  await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [] },
    { id: 'b', title: 'B', prompt: 'do B', deps: [] },
  ]);
  await waitUntil(() => sessions.length === 2, 'parallel workers were not created');
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.ended === false));

  orch.end();

  assert.ok(
    sessions.every((s) => s.ended === true),
    'all live worker sessions ended on orchestrator.end()',
  );
});

test('disposeWorker is idempotent (double end() does not throw)', async () => {
  const { orch, sessions } = makeOrch();
  await orch.installPlan([{ id: 'a', title: 'A', prompt: 'do A', deps: [] }]);
  await waitUntil(() => sessions.length === 1, 'worker session was not created');
  orch.schedulerOnWorkerEvent('a', {
    kind: 'worker-signal',
    signal: {
      kind: 'failed',
      code: 'fixture-failure',
      message: 'first',
      retryable: false,
    },
  });
  await waitUntil(() => sessions[0].ended, 'failed worker was not disposed');
  // Re-firing an SDK end event after terminal cleanup is a no-op.
  assert.doesNotThrow(() => orch.schedulerOnWorkerEvent('a', { kind: 'ended' }));
  assert.equal(sessions[0].ended, true);
  orch.end();
});

test('worker receives its first task only after backend readiness resolves', async () => {
  let releaseReady;
  const ready = new Promise((resolve) => { releaseReady = resolve; });
  const sessions = [];
  const orch = new Orchestrator({
    emit() {},
    cwd: '/tmp',
    sessionFactory: () => {
      const session = new FakeSession();
      session.start = () => ready.then(() => { session.started = true; });
      sessions.push(session);
      return session;
    },
  });

  await orch.installPlan([{ id: 'ready-gate', title: 'Ready', prompt: 'do work', deps: [] }]);
  await waitUntil(() => sessions.length === 1, 'worker session was not created');
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].inputs, [], 'task is not sent during backend handshake');

  releaseReady();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(sessions[0].inputs[0]?.text ?? '', /^## Task\ndo work/);
  assert.match(sessions[0].inputs[0]?.text ?? '', /## Frozen visible context/);
  await orch.end();
});
