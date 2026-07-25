import assert from 'node:assert/strict';
import test from 'node:test';

import { DeterministicDeliveryReviewer } from '../dist-electron/delivery-reviewer.js';

const order = {
  deliveryId: 'd',
  attempt: 1,
  meetingId: 'm',
  goal: 'review',
  workspace: '/repo',
  sourceRevision: 'base',
  acceptanceCriteria: [{ id: 'manual', description: 'review', verification: { kind: 'manual' } }],
};

test('reviewer accepts a completed, verified and resolved report', async () => {
  const reviewer = new DeterministicDeliveryReviewer();
  const verdict = await reviewer.review(order, {
    status: 'completed',
    summary: 'done',
    files: [{ path: 'src/a.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'passed' }],
    unresolved: [],
  }, { passed: true, checks: [] });
  assert.equal(verdict.passed, true);
});

test('reviewer rejects failed/not-run tests and blocking unresolved items', async () => {
  const reviewer = new DeterministicDeliveryReviewer();
  const verdict = await reviewer.review(order, {
    status: 'completed',
    summary: 'not done',
    files: [{ path: 'src/a.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'not-run' }],
    unresolved: [{ code: 'blocked', message: 'needs input', blocking: true }],
  }, { passed: true, checks: [] });
  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.findings.map((f) => f.code), ['reported-test-not-run', 'blocked']);
});

test('report-only not-run tests are warnings and do not fail review', async () => {
  const reviewer = new DeterministicDeliveryReviewer();
  const verdict = await reviewer.review(order, {
    status: 'completed',
    summary: 'explored',
    files: [],
    tests: [{ command: 'npm test', status: 'not-run' }],
    unresolved: [],
  }, { passed: true, checks: [] });
  assert.equal(verdict.passed, true);
  assert.equal(verdict.findings[0]?.severity, 'warning');
  assert.equal(verdict.findings[0]?.code, 'reported-test-not-run');
});
