import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CoordinatorReviewDriver,
} from '../dist-electron/coordinator-review-driver.js';
import { DeliveryHarness } from '../dist-electron/delivery-harness.js';

import candidate from './fixtures/coordinator-review-candidate.json' with { type: 'json' };

/** Two-chunk candidate so stall accounting can be observed across partial coverage. */
function twoChunkCandidate() {
  const frozen = structuredClone(candidate);
  frozen.manifest.chunks = [
    structuredClone(candidate.manifest.chunks[0]),
    {
      ...structuredClone(candidate.manifest.chunks[0]),
      id: 'fixture-chunk-2',
      index: 1,
      path: 'src/other.ts',
      hash: '2'.repeat(64),
    },
  ];
  return frozen;
}

function makeDriver(maxTurns = 3) {
  const calls = [];
  const completed = [];
  const reworks = [];
  const paused = [];
  const driver = new CoordinatorReviewDriver({
    onPaused: async (session) => {
      paused.push(session);
    },
    maxTurns,
    now: (() => {
      let value = 100;
      return () => ++value;
    })(),
    id: () => 'review-driver-1',
    append: async (type, payload) => {
      calls.push({ kind: 'append', type, payload });
    },
    flush: async () => {
      calls.push({ kind: 'flush' });
    },
    notifyCoordinator: async (briefing) => {
      calls.push({ kind: 'notify', briefing });
    },
    onCompleted: async (session) => {
      completed.push(session);
    },
    onReworkRequested: async (session) => {
      reworks.push(session);
    },
  });
  return { driver, calls, completed, reworks, paused };
}

test('request persists and flushes before notifying the Coordinator', async () => {
  const { driver, calls } = makeDriver();
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  assert.equal(session.status, 'active');
  assert.deepEqual(calls.map((call) => call.kind), ['append', 'flush', 'notify']);
  assert.equal(calls[0].type, 'coordinator-review-requested');
  assert.equal(calls[2].briefing.chunkId, 'fixture-chunk-1');
  assert.equal(JSON.stringify(calls).includes('+change'), false);
});

test('review completion is idempotent and calls the completion owner once', async () => {
  const { driver, completed } = makeDriver();
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  await driver.submitChunkReview(session.id, {
    chunkId: 'fixture-chunk-1',
    chunkHash: candidate.manifest.chunks[0].hash,
    verdict: 'passed',
    findings: [],
  });
  const first = await driver.complete(session.id);
  const second = await driver.complete(session.id);
  assert.equal(first.reviewHash, second.reviewHash);
  assert.equal(completed.length, 1);
});

test('incomplete Coordinator turns queue bounded continuation then pause', async () => {
  const { driver, calls } = makeDriver(2);
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  await driver.onCoordinatorTurnEnded(session.id);
  assert.equal(driver.inspect(session.id).status, 'active');
  await driver.onCoordinatorTurnEnded(session.id);
  assert.equal(driver.inspect(session.id).status, 'paused');
  assert.ok(calls.some((call) => call.type === 'coordinator-review-turn-queued'));
  assert.ok(calls.some((call) => call.type === 'coordinator-review-paused'));
});

test('briefing names every uncovered chunk and the exact next call', async () => {
  const { driver, calls } = makeDriver();
  await driver.request({
    candidate: twoChunkCandidate(),
    verification: { passed: true, checks: [] },
  });
  const { briefing } = calls.find((call) => call.kind === 'notify');
  assert.deepEqual(briefing.uncoveredChunkIds, ['fixture-chunk-1', 'fixture-chunk-2']);
  assert.equal(briefing.remainingChunks, 2);
  assert.equal(briefing.turnCount, 0);
  assert.match(briefing.nextAction, /get_delivery_review_chunk/);
  assert.match(briefing.nextAction, /fixture-chunk-2/);
});

test('covering a chunk clears the stall budget so unrelated turns cannot pause a live review', async () => {
  const { driver, paused } = makeDriver(2);
  const frozen = twoChunkCandidate();
  const session = await driver.request({
    candidate: frozen,
    verification: { passed: true, checks: [] },
  });

  await driver.onCoordinatorTurnEnded(session.id);
  assert.equal(driver.inspect(session.id).turnCount, 1);

  await driver.submitChunkReview(session.id, {
    chunkId: 'fixture-chunk-1',
    chunkHash: frozen.manifest.chunks[0].hash,
    verdict: 'passed',
    findings: [],
  });
  assert.equal(driver.inspect(session.id).turnCount, 0, 'real progress must reset the stall counter');

  await driver.onCoordinatorTurnEnded(session.id);
  assert.equal(driver.inspect(session.id).status, 'active');
  assert.equal(paused.length, 0);
});

test('a review that never progresses pauses and escalates instead of passing', async () => {
  const { driver, paused } = makeDriver(2);
  const session = await driver.request({
    candidate: twoChunkCandidate(),
    verification: { passed: true, checks: [] },
  });
  await driver.onCoordinatorTurnEnded(session.id);
  await driver.onCoordinatorTurnEnded(session.id);

  const stalled = driver.inspect(session.id);
  assert.equal(stalled.status, 'paused');
  assert.equal(stalled.pauseReason, 'review-turn-budget-exhausted');
  assert.equal(paused.length, 1);
  assert.deepEqual(driver.activeSessions(), []);
  assert.deepEqual(driver.pausedSessions().map((entry) => entry.id), [session.id]);
  await assert.rejects(() => driver.complete(session.id), /incomplete review coverage/);
});

test('disconnect pause is reported to the escalation owner', async () => {
  const { driver, paused } = makeDriver();
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  await driver.pauseForDisconnect(session.id);
  assert.deepEqual(paused.map((entry) => entry.pauseReason), ['coordinator-disconnected']);
});

test('restore resumes the exact unreviewed cursor without notifying twice', async () => {
  const { driver } = makeDriver();
  const created = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  const snapshot = driver.inspect(created.id);

  const restoredCalls = [];
  const restored = new CoordinatorReviewDriver({
    append: async (type) => restoredCalls.push(type),
    flush: async () => {},
    notifyCoordinator: async (briefing) => restoredCalls.push(briefing.chunkId),
  });
  restored.restore(snapshot);
  assert.equal(restored.inspect(snapshot.id).cursor, snapshot.cursor);
  await restored.resume(snapshot.id);
  assert.deepEqual(restoredCalls, [
    'coordinator-review-resumed',
    'fixture-chunk-1',
  ]);
});

test('snapshot and restore preserve exact chunk coverage and confirmations', async () => {
  const { driver } = makeDriver();
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  await driver.submitChunkReview(session.id, {
    chunkId: 'fixture-chunk-1',
    chunkHash: candidate.manifest.chunks[0].hash,
    verdict: 'passed',
    findings: [],
  });
  const snapshots = driver.snapshot();
  const restored = makeDriver().driver;
  for (const snapshot of snapshots) restored.restore(snapshot);
  assert.deepEqual(restored.snapshot(), snapshots);
  assert.equal(restored.inspect(session.id).coverage.complete, true);
});

test('Coordinator disconnect pauses without discarding the durable review', async () => {
  const { driver } = makeDriver();
  const session = await driver.request({
    candidate,
    verification: { passed: true, checks: [] },
  });
  await driver.pauseForDisconnect(session.id);
  assert.equal(driver.inspect(session.id).status, 'paused');
  assert.equal(driver.inspect(session.id).pauseReason, 'coordinator-disconnected');
});

test('DeliveryHarness stays coordinator-reviewing until complete hash-bound coverage', async () => {
  const workReport = {
    status: 'completed',
    summary: 'done',
    files: [{ path: 'src/app.ts', action: 'modified' }],
    tests: [{ command: 'node --test', status: 'passed' }],
    unresolved: [],
  };
  const verification = { passed: true, checks: [] };
  let harness;
  const driver = new CoordinatorReviewDriver({
    id: () => 'review-harness',
    append: async () => {},
    flush: async () => {},
    notifyCoordinator: async () => {},
    onCompleted: async (session) => {
      await harness.completeCoordinatorReview(session.deliveryId, session);
    },
  });
  const frozen = structuredClone(candidate);
  frozen.deliveryId = 'delivery-harness';
  frozen.taskId = 'task-harness';
  frozen.reportHash = hashJson(workReport);
  frozen.verificationHash = hashJson(verification);
  harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { verify: async () => verification },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    candidatePreparer: { prepare: async () => frozen },
    reviewDriver: driver,
    integrator: { integrate: async () => ({}) },
    id: () => 'delivery-harness',
    now: () => 100,
  });
  const proposed = await harness.propose({
    meetingId: 'meeting-1',
    taskId: 'task-harness',
    objective: 'test',
    workspace: 'C:/workspace',
    sourceRevision: frozen.baseRevision,
    acceptanceCriteria: [{ id: 'test', description: 'test', verification: { kind: 'manual' } }],
  });
  await harness.decide(proposed.id, { kind: 'approve-spec', specVersion: 1 });
  const reviewing = await harness.submitExternalReport(proposed.id, workReport);
  assert.equal(reviewing.status, 'coordinator-reviewing');
  assert.equal(reviewing.candidate, undefined);

  await driver.submitChunkReview('review-harness', {
    chunkId: 'fixture-chunk-1',
    chunkHash: candidate.manifest.chunks[0].hash,
    verdict: 'passed',
    findings: [],
  });
  await driver.complete('review-harness');
  const ready = await harness.inspect(proposed.id);
  assert.equal(ready.status, 'accepted');
  assert.equal(ready.candidate.frozen.commit, frozen.commit);
  assert.equal(ready.candidate.reviewSession.id, 'review-harness');
});

function hashJson(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
