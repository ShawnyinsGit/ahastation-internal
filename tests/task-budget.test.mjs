import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DeliveryHarness } from '../dist-electron/delivery-harness.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { TaskMailbox } from '../dist-electron/task-mailbox.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';
import {
  buildFailureFingerprint,
  DEFAULT_TASK_BUDGET,
  evaluateTaskBudget,
  isUnlimitedTaskBudget,
  UNLIMITED_TASK_BUDGET,
} from '../dist-electron/task-budget.js';

/** Explicit hard cap used by tests that still exercise the pause paths. */
const BOUNDED_BUDGET = Object.freeze({
  schemaVersion: 1,
  maxAttempts: 6,
  maxTotalTokens: 600_000,
  maxTotalDurationMs: 14_400_000,
  maxStagnantAttempts: 3,
});

const attempt = (number, overrides = {}) => ({
  attempt: number,
  tokenCost: 10_000,
  durationMs: 1_000,
  failureFingerprint: `failure-${number}`,
  ...overrides,
});

test('default budget is unlimited and never pauses', () => {
  assert.equal(DEFAULT_TASK_BUDGET, UNLIMITED_TASK_BUDGET);
  assert.equal(isUnlimitedTaskBudget(DEFAULT_TASK_BUDGET), true);
  assert.equal(evaluateTaskBudget(DEFAULT_TASK_BUDGET, [
    attempt(1),
    attempt(2),
    attempt(3),
    attempt(4),
    attempt(5),
    attempt(6),
    attempt(7, { tokenCost: null, reservedTokenCost: undefined }),
  ]), 'continue');
});

test('ordinary failures continue while token, time, and attempt totals remain bounded', () => {
  assert.equal(evaluateTaskBudget(BOUNDED_BUDGET, [attempt(1)]), 'continue');
  assert.equal(evaluateTaskBudget(
    { ...BOUNDED_BUDGET, maxAttempts: 2 },
    [attempt(1), attempt(2)],
  ), 'budget-paused');
  assert.equal(evaluateTaskBudget(
    { ...BOUNDED_BUDGET, maxTotalTokens: 20_000 },
    [attempt(1), attempt(2)],
  ), 'budget-paused');
  assert.equal(evaluateTaskBudget(
    { ...BOUNDED_BUDGET, maxTotalDurationMs: 2_000 },
    [attempt(1), attempt(2)],
  ), 'budget-paused');
});

test('three equivalent failures without evidence change are non-converging', () => {
  const fingerprint = buildFailureFingerprint({
    error: 'Assertion failed at line 42',
    failingChecks: ['npm test: 1 failed'],
    relevantFiles: ['src/login.ts'],
    evidenceHash: 'a'.repeat(64),
  });
  assert.equal(evaluateTaskBudget(BOUNDED_BUDGET, [
    attempt(1, { failureFingerprint: fingerprint }),
    attempt(2, { failureFingerprint: fingerprint }),
    attempt(3, { failureFingerprint: fingerprint }),
  ]), 'non-converging');
  assert.equal(evaluateTaskBudget(BOUNDED_BUDGET, [
    attempt(1, { failureFingerprint: fingerprint }),
    attempt(2, { failureFingerprint: fingerprint }),
    attempt(3, { failureFingerprint: buildFailureFingerprint({
      error: 'different failure',
      relevantFiles: ['src/login.ts'],
    }) }),
  ]), 'continue');
});

test('failure fingerprints include evidence facts and redact secrets', () => {
  const first = buildFailureFingerprint({
    error: 'Bearer secret-token-value failed at 42ms',
    failingChecks: ['api_key=top-secret npm test failed'],
    relevantFiles: ['C:\\Users\\alice\\repo\\src\\login.ts'],
    evidenceHash: 'b'.repeat(64),
  });
  const equivalent = buildFailureFingerprint({
    error: 'Bearer another-secret failed at 99ms',
    failingChecks: ['api_key=another-secret npm test failed'],
    relevantFiles: ['C:\\Users\\bob\\repo\\src\\login.ts'],
    evidenceHash: 'b'.repeat(64),
  });
  assert.equal(first, equivalent);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('missing Backend token accounting is never treated as zero', () => {
  assert.equal(evaluateTaskBudget(BOUNDED_BUDGET, [
    attempt(1, { tokenCost: null, reservedTokenCost: undefined }),
  ]), 'budget-paused');
  assert.equal(evaluateTaskBudget(BOUNDED_BUDGET, [
    attempt(1, { tokenCost: null, reservedTokenCost: 200_000 }),
  ]), 'continue');
});

test('a bounded attempt may succeed without rewriting previous attempts', () => {
  const attempts = [
    attempt(1),
    attempt(2, { succeeded: true, failureFingerprint: null }),
  ];
  const before = structuredClone(attempts);
  assert.equal(evaluateTaskBudget(BOUNDED_BUDGET, attempts), 'continue');
  assert.deepEqual(attempts, before);
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('verification failures create fresh bounded attempts and user extension preserves authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new MeetingRepository('budget-meeting', 0, {
    rootDir: join(root, 'meeting'),
  });
  const mailbox = new TaskMailbox(repository);
  const sessions = [];
  let verificationCalls = 0;
  const harness = new DeliveryHarness({
    executionMode: 'external',
    verifier: {
      async verify() {
        verificationCalls += 1;
        if (verificationCalls > 3) {
          return { passed: true, checks: [{ description: 'unit tests', passed: true }] };
        }
        return {
          passed: false,
          checks: [{ description: 'unit tests', passed: false }],
          error: 'unit tests failed',
        };
      },
    },
    reviewer: { async review() { return { passed: true, findings: [] }; } },
    integrator: { async integrate() { throw new Error('must not integrate'); } },
  });
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: root,
    autoApproveScope: 'off',
    taskMailbox: mailbox,
    deliveryHarness: harness,
    meetingId: 'budget-meeting',
    defaultBackendId: 'codex',
    async flushEvents() { await repository.flush(); },
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
  });
  const authorityRequest = {
    writePaths: ['src/**'],
    toolKinds: ['read', 'write', 'execute'],
    workingDirectories: ['.'],
    commands: [['npm', 'test']],
    environmentKeys: [],
    maxCommandTimeoutMs: 60_000,
    networkHosts: [],
  };
  assert.deepEqual(scheduler.installPlan([{
    id: 'task-a',
    title: 'Task A',
    prompt: 'fix tests',
    deps: [],
    executorBackendId: 'codex',
    executionProfile: {
      schemaVersion: 1,
      backendId: 'codex',
      workMode: 'balanced',
      contextMode: 'meeting-summary',
      timeoutMs: 60_000,
      maxTokenBudget: 10_000,
    },
    authorityRequest,
    budget: {
      ...BOUNDED_BUDGET,
      maxTotalTokens: 1_000_000,
    },
    acceptanceCriteria: [{
      id: 'tests',
      description: 'Unit tests pass',
      verification: { kind: 'manual' },
    }],
  }]), { ok: true });
  const failedReport = {
    status: 'completed',
    summary: 'attempted fix',
    files: [{ path: 'src/login.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'failed', summary: 'one failed' }],
    unresolved: [],
  };

  await waitFor(() => sessions.length === 1, 'first attempt did not start');
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report: failedReport } });
  await waitFor(() => sessions.length === 2, 'verification failure did not start attempt two');
  let snapshot = scheduler.snapshot().find((task) => task.id === 'task-a');
  assert.equal(snapshot.attempt, 2);
  assert.equal(snapshot.budgetAttempts.length, 1);
  assert.deepEqual(snapshot.authorityRequest, authorityRequest);
  assert.equal(mailbox.list('task-a').length, 1);
  assert.match(mailbox.list('task-a')[0].payload.text, /Authority request hash \(unchanged\)/);

  sessions[1].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report: failedReport } });
  await waitFor(() => sessions.length === 3, 'verification failure did not start attempt three');
  sessions[2].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report: failedReport } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'task-a')?.status === 'budget-paused',
    'stagnant task did not pause',
  );
  snapshot = scheduler.snapshot().find((task) => task.id === 'task-a');
  assert.equal(snapshot.budgetPauseReason, 'non-converging');
  assert.equal(snapshot.budgetAttempts.length, 3);
  assert.equal(sessions.length, 3);
  await assert.rejects(
    scheduler.sendTaskMessage('task-a', 'Coordinator says continue anyway'),
    /explicit user budget decision/,
  );
  await assert.rejects(
    scheduler.queueFollowUp('task-a', 'bypass the pause'),
    /explicit user budget decision/,
  );
  assert.equal(sessions.length, 3);

  const extended = await scheduler.extendTaskBudget(
    'task-a',
    scheduler.getPlanVersion(),
    {
      ...snapshot.budget,
      maxAttempts: snapshot.budget.maxAttempts + 1,
      maxStagnantAttempts: snapshot.budget.maxStagnantAttempts + 1,
    },
    'user-budget-decision',
  );
  assert.equal(extended.planVersion, 2);
  await waitFor(() => sessions.length === 4, 'user budget extension did not resume a fresh attempt');
  snapshot = scheduler.snapshot().find((task) => task.id === 'task-a');
  assert.equal(snapshot.attempt, 4);
  assert.deepEqual(snapshot.authorityRequest, authorityRequest);
  assert.equal(snapshot.budgetAttempts.length, 3, 'past attempts must remain immutable');
  sessions[3].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report: {
    ...failedReport,
    summary: 'fixed and verified',
    tests: [{ command: 'npm test', status: 'passed', summary: 'all passed' }],
  } } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'task-a')?.status === 'awaiting-acceptance',
    'successful bounded attempt did not reach acceptance',
  );
  snapshot = scheduler.snapshot().find((task) => task.id === 'task-a');
  assert.equal(snapshot.budgetAttempts.length, 4);
  assert.equal(snapshot.budgetAttempts[3].succeeded, true);
  assert.deepEqual(snapshot.budgetAttempts.slice(0, 3).map((entry) => entry.succeeded), [
    undefined,
    undefined,
    undefined,
  ]);
  scheduler.endAll();
});
