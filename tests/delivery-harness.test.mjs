import assert from 'node:assert/strict';
import test from 'node:test';

import { DeliveryHarness } from '../dist-electron/delivery-harness.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(harness, id, status) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const view = await harness.inspect(id);
    if (view.status === status) return view;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`delivery ${id} did not reach ${status}`);
}

test('approved delivery requires independent verification and review before user acceptance', async () => {
  const execution = deferred();
  const calls = { verify: 0, review: 0, integrate: 0 };
  const harness = new DeliveryHarness({
    runtime: {
      execute: async () => execution.promise,
    },
    verifier: {
      verify: async (_order, report) => {
        calls.verify += 1;
        return { passed: true, checks: report.tests };
      },
    },
    reviewer: {
      review: async () => {
        calls.review += 1;
        return { passed: true, findings: [] };
      },
    },
    integrator: {
      integrate: async () => {
        calls.integrate += 1;
        return { commit: 'result-commit' };
      },
    },
  });

  const proposed = await harness.propose({
    meetingId: 'meeting-1',
    objective: 'Implement a verified change',
    workspace: '/repo',
    sourceRevision: 'base-commit',
    acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
  });
  assert.equal(proposed.status, 'awaiting-spec-approval');

  await harness.decide(proposed.id, { kind: 'approve-spec', specVersion: 1 });
  await waitFor(harness, proposed.id, 'executing');
  execution.resolve({
    status: 'completed',
    summary: 'implemented',
    files: [{ path: 'src/a.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'passed', summary: 'unit passed' }],
    unresolved: [],
  });

  const reviewReady = await waitFor(harness, proposed.id, 'awaiting-delivery-acceptance');
  assert.equal(calls.verify, 1);
  assert.equal(calls.review, 1);
  assert.equal(calls.integrate, 0);
  assert.equal(reviewReady.candidate.verification.passed, true);
  assert.equal(reviewReady.candidate.review.passed, true);

  const accepted = await harness.decide(proposed.id, {
    kind: 'accept-delivery', candidateId: reviewReady.candidate.id,
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration.commit, 'result-commit');
  assert.equal(calls.integrate, 1);
});

test('agent completion cannot produce a delivery candidate when verification fails', async () => {
  let reviewed = false;
  const harness = new DeliveryHarness({
    runtime: {
      execute: async () => ({
        status: 'completed', summary: 'claimed complete', files: [],
        tests: [{ command: 'npm test', status: 'failed', summary: 'unit failed' }],
        unresolved: [],
      }),
    },
    verifier: {
      verify: async () => ({ passed: false, checks: [], error: 'unit test failed' }),
    },
    reviewer: {
      review: async () => { reviewed = true; return { passed: true, findings: [] }; },
    },
    integrator: { integrate: async () => ({}) },
  });
  const proposed = await harness.propose({
    meetingId: 'meeting-2', objective: 'must verify', workspace: '/repo',
    sourceRevision: 'base', acceptanceCriteria: [{ id: 'tests', description: 'tests pass' }],
  });
  await harness.decide(proposed.id, { kind: 'approve-spec', specVersion: 1 });
  const failed = await waitFor(harness, proposed.id, 'reworking');
  assert.equal(failed.error, 'unit test failed');
  assert.equal(failed.candidate, undefined);
  assert.equal(failed.attempts[0].outcome, 'verification-failed');
  assert.equal(failed.attempts[0].verification.passed, false);
  assert.equal(reviewed, false);
  const scheduled = await harness.decide(proposed.id, {
    kind: 'return-delivery',
    feedback: 'fix the failing unit test',
  });
  assert.equal(scheduled.status, 'reworking');
  assert.equal(scheduled.attempts[0].feedback, 'fix the failing unit test');
  assert.match(scheduled.spec.objective, /fix the failing unit test/);
  // Host can still Accept the current report instead of forcing another attempt.
  const accepted = await harness.decide(proposed.id, {
    kind: 'accept-delivery',
    candidateId: `accept-last-${proposed.id}`,
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration?.kind, 'report-only');
});

test('delivery observers continue from a cursor and receive later state changes in order', async () => {
  const execution = deferred();
  const harness = new DeliveryHarness({
    runtime: { execute: async () => execution.promise },
    verifier: { verify: async () => ({ passed: true, checks: [] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({}) },
  });
  const proposed = await harness.propose({
    meetingId: 'meeting-3', objective: 'observable delivery', workspace: '/repo',
    sourceRevision: 'base', acceptanceCriteria: [{ id: 'done', description: 'done' }],
  });
  const stream = harness.observe(proposed.id, 1)[Symbol.asyncIterator]();
  const nextEvent = stream.next();
  await harness.decide(proposed.id, { kind: 'approve-spec', specVersion: 1 });
  const event = await Promise.race([
    nextEvent,
    new Promise((_, reject) => setTimeout(() => reject(new Error('observer timed out')), 200)),
  ]);
  assert.equal(event.done, false);
  assert.equal(event.value.seq, 2);
  assert.equal(event.value.status, 'preparing-workspace');
  execution.resolve({
    status: 'completed', summary: 'done', files: [], tests: [], unresolved: [],
  });
  await waitFor(harness, proposed.id, 'awaiting-delivery-acceptance');
});

test('integration failures are terminal and accepted deliveries cannot be cancelled', async () => {
  const makeHarness = (integrate) => new DeliveryHarness({
    runtime: { execute: async () => ({
      status: 'completed',
      summary: 'done',
      files: [{ path: 'src/a.ts', action: 'modified' }],
      tests: [],
      unresolved: [],
    }) },
    verifier: { verify: async () => ({ passed: true, checks: ['ok'] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate },
  });
  const proposal = {
    meetingId: 'meeting-4', objective: 'integrate safely', workspace: '/repo',
    sourceRevision: 'base', acceptanceCriteria: [{ id: 'done', description: 'done' }],
  };

  const failing = makeHarness(async () => { throw new Error('branch moved'); });
  const failedRun = await failing.propose(proposal);
  await failing.decide(failedRun.id, { kind: 'approve-spec', specVersion: 1 });
  const candidate = await waitFor(failing, failedRun.id, 'awaiting-delivery-acceptance');
  await assert.rejects(
    failing.decide(failedRun.id, { kind: 'accept-delivery', candidateId: candidate.candidate.id }),
    /branch moved/,
  );
  assert.equal((await failing.inspect(failedRun.id)).status, 'failed');

  const successful = makeHarness(async () => ({ commit: 'abc' }));
  const acceptedRun = await successful.propose(proposal);
  await successful.decide(acceptedRun.id, { kind: 'approve-spec', specVersion: 1 });
  const ready = await waitFor(successful, acceptedRun.id, 'awaiting-delivery-acceptance');
  await successful.decide(acceptedRun.id, { kind: 'accept-delivery', candidateId: ready.candidate.id });
  await assert.rejects(successful.decide(acceptedRun.id, { kind: 'cancel' }), /cannot cancel/);
});

test('external reports are accepted exactly once and rework creates a new attempt', async () => {
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { verify: async () => ({ passed: true, checks: ['ok'] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({}) },
  });
  const proposal = await harness.propose({
    meetingId: 'meeting-external',
    objective: 'external worker',
    workspace: '/repo',
    sourceRevision: 'base',
    acceptanceCriteria: [{ id: 'manual', description: 'review result', verification: { kind: 'manual' } }],
  });
  const executing = await harness.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  assert.equal(executing.status, 'executing');
  assert.equal(executing.attempt, 1);

  const report = { status: 'completed', summary: 'done', files: [], tests: [], unresolved: [] };
  const ready = await harness.submitExternalReport(proposal.id, report);
  assert.equal(ready.status, 'awaiting-delivery-acceptance');
  await assert.rejects(harness.submitExternalReport(proposal.id, report), /not accepting reports/);

  const reworking = await harness.decide(proposal.id, {
    kind: 'return-delivery',
    candidateId: ready.candidate.id,
    feedback: 'please revise',
  });
  assert.equal(reworking.status, 'reworking');
  const second = await harness.submitExternalReport(proposal.id, report);
  assert.equal(second.attempt, 2);
  assert.equal(second.status, 'awaiting-delivery-acceptance');
});

test('journaled delivery evidence restores as interrupted and resumes only by user action', async () => {
  const dependencies = {
    executionMode: 'external',
    verifier: { verify: async () => ({ passed: true, checks: ['restored-check'] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({}) },
  };
  const original = new DeliveryHarness(dependencies);
  const proposal = await original.propose({
    meetingId: 'meeting-recovery',
    objective: 'preserve evidence',
    workspace: '/repo',
    sourceRevision: 'base',
    acceptanceCriteria: [{ id: 'manual', description: 'review result', verification: { kind: 'manual' } }],
  });
  await original.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  const ready = await original.submitExternalReport(proposal.id, {
    status: 'completed',
    summary: 'first attempt evidence',
    files: [{ path: 'result.txt', action: 'created' }],
    tests: [{ command: 'node --test', status: 'passed' }],
    unresolved: [],
  });

  const recovered = new DeliveryHarness(dependencies);
  const interrupted = recovered.restore(ready);
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.candidate, undefined);
  assert.equal(interrupted.attempts[0].report.summary, 'first attempt evidence');
  await assert.rejects(
    recovered.submitExternalReport(interrupted.id, {
      status: 'completed', summary: 'must not auto-run', files: [], tests: [], unresolved: [],
    }),
    /not accepting reports/,
  );

  const reworking = await recovered.decide(interrupted.id, {
    kind: 'resume-after-interruption',
    mode: 'continue',
  });
  assert.equal(reworking.status, 'reworking');
  const second = await recovered.submitExternalReport(interrupted.id, {
    status: 'completed', summary: 'second attempt', files: [], tests: [], unresolved: [],
  });
  assert.equal(second.attempt, 2);
  assert.equal(second.attempts.length, 2);
  assert.equal(second.attempts[0].report.summary, 'first attempt evidence');
});

test('report-only completed delivery skips freeze and reaches host acceptance', async () => {
  let freezeCalls = 0;
  let reviewDriverCalls = 0;
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { verify: async () => ({ passed: true, checks: ['ok'] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({ integrated: true }) },
    candidatePreparer: {
      prepare: async () => {
        freezeCalls += 1;
        throw new Error('freeze must not run for report-only');
      },
    },
    reviewDriver: {
      request: async () => {
        reviewDriverCalls += 1;
        throw new Error('coordinator must not run for report-only');
      },
    },
  });
  const proposal = await harness.propose({
    meetingId: 'meeting-report-only',
    objective: 'explore only',
    workspace: '/repo',
    sourceRevision: 'abc123',
    acceptanceCriteria: [{ id: 'manual', description: 'review', verification: { kind: 'manual' } }],
  });
  await harness.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  const ready = await harness.submitExternalReport(proposal.id, {
    status: 'completed',
    summary: 'findings only',
    files: [],
    tests: [{ command: 'rg TODO', status: 'not-run' }],
    unresolved: [],
  });
  assert.equal(ready.status, 'awaiting-delivery-acceptance');
  assert.equal(ready.candidate?.reportOnly, true);
  assert.equal(freezeCalls, 0);
  assert.equal(reviewDriverCalls, 0);
});

test('report-only partial delivery hands off to host instead of auto-rework', async () => {
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { verify: async () => ({ passed: true, checks: [] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({ integrated: true }) },
  });
  const proposal = await harness.propose({
    meetingId: 'meeting-partial',
    objective: 'explore',
    workspace: '/repo',
    sourceRevision: 'abc123',
    acceptanceCriteria: [{ id: 'manual', description: 'review', verification: { kind: 'manual' } }],
  });
  await harness.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  const ready = await harness.submitExternalReport(proposal.id, {
    status: 'partial',
    summary: 'partial findings',
    files: [],
    tests: [],
    unresolved: [{ code: 'needs-host', message: 'confirm direction', blocking: false }],
  });
  assert.equal(ready.status, 'awaiting-delivery-acceptance');
  assert.equal(ready.candidate?.reportOnly, true);
  assert.match(ready.error ?? '', /partial/);
});

test('host can accept the last report while delivery is parked in reworking', async () => {
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: {
      verify: async () => ({ passed: false, checks: [], error: 'needs host' }),
    },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({ integrated: true }) },
  });
  const proposal = await harness.propose({
    meetingId: 'meeting-rework-accept',
    objective: 'code change',
    workspace: '/repo',
    sourceRevision: 'abc123',
    acceptanceCriteria: [{ id: 'manual', description: 'review', verification: { kind: 'manual' } }],
  });
  await harness.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  const parked = await harness.submitExternalReport(proposal.id, {
    status: 'completed',
    summary: 'good enough for host',
    files: [{ path: 'src/a.ts', action: 'modified' }],
    tests: [],
    unresolved: [],
  });
  assert.equal(parked.status, 'reworking');
  assert.equal(parked.candidate, undefined);

  const accepted = await harness.decide(proposal.id, {
    kind: 'accept-delivery',
    candidateId: `accept-last-${proposal.id}`,
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration?.kind, 'report-only');
});

test('candidate freeze failure hands the report to the host instead of auto-rework', async () => {
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: { verify: async () => ({ passed: true, checks: ['ok'] }) },
    reviewer: { review: async () => ({ passed: true, findings: [] }) },
    integrator: { integrate: async () => ({ integrated: true }) },
    candidatePreparer: {
      prepare: async () => {
        throw new Error('worktree contains unreported changes: package.json');
      },
    },
    reviewDriver: {
      request: async () => {
        throw new Error('review driver must not run when freeze fails');
      },
    },
  });
  const proposal = await harness.propose({
    meetingId: 'meeting-freeze',
    objective: 'explore only',
    workspace: '/repo',
    sourceRevision: 'abc123',
    acceptanceCriteria: [{ id: 'manual', description: 'review', verification: { kind: 'manual' } }],
  });
  await harness.decide(proposal.id, { kind: 'approve-spec', specVersion: 1 });
  const ready = await harness.submitExternalReport(proposal.id, {
    status: 'completed',
    summary: 'changed one file; freeze should still hand off to host',
    files: [{ path: 'src/feature.ts', action: 'modified' }],
    tests: [{ command: 'grep', status: 'passed' }],
    unresolved: [],
  });
  assert.equal(ready.status, 'awaiting-delivery-acceptance');
  assert.match(ready.error ?? '', /unreported changes/);
  assert.equal(ready.candidate?.reportOnly, true);
  assert.equal(ready.candidate?.frozen, undefined);
  assert.match(ready.attempts.at(-1)?.feedback ?? '', /candidate freeze deferred/);

  const accepted = await harness.decide(proposal.id, {
    kind: 'accept-delivery',
    candidateId: ready.candidate.id,
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.integration?.kind, 'report-only');
});
