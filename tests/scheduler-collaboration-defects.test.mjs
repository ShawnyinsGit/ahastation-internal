import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

// Regression coverage for the host↔worker collaboration defect sweep
// (#1 orphan spawn, #2 late-report revival, #3 stale-attempt tools,
// #4 delivery observer/follow-up races, #5 late settle, #6 parked error,
// #7 permission namespacing, #8 interruptAll×steer, #9 mailbox carry-over,
// #10 eventSeq persistence). Tests import the compiled scheduler, so
// TypeScript-private fields (workers, permissionTimers, askOwnersByRequestId,
// disposeWorker, armPermissionTimeout, …) are reachable plain properties —
// used to construct states that are hard to hit through the public API.

const report = {
  status: 'completed',
  summary: 'implemented and tested',
  files: [{ path: 'src/result.ts', action: 'modified' }],
  tests: [{ command: 'npm test', status: 'passed', summary: 'all green' }],
  unresolved: [],
};

const PROTOCOL_CORRECTION_PREFIX = '[AhaStation protocol correction]';

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function inMemoryMailbox() {
  const byTask = new Map();
  let seq = 0;
  const find = (taskId, id) => (byTask.get(taskId) ?? []).find((m) => m.id === id);
  return {
    async enqueue(input) {
      const id = input.id ?? `m-${++seq}`;
      const message = {
        schemaVersion: 1,
        id,
        seq: ++seq,
        taskId: input.taskId,
        attempt: input.attempt,
        sender: input.sender,
        kind: input.kind,
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        payload: input.payload,
        status: 'queued',
        timestamp: Date.now(),
      };
      const list = byTask.get(input.taskId) ?? [];
      list.push(message);
      byTask.set(input.taskId, list);
      return structuredClone(message);
    },
    async markDelivered(taskId, id) {
      const m = find(taskId, id);
      if (m && m.status !== 'acknowledged') m.status = 'delivered';
      return structuredClone(m);
    },
    async markFailed(taskId, id) {
      const m = find(taskId, id);
      if (m && m.status !== 'acknowledged') m.status = 'queued';
      return structuredClone(m);
    },
    async acknowledge(taskId, id) {
      const m = find(taskId, id);
      if (m) m.status = 'acknowledged';
      return structuredClone(m);
    },
    get(taskId, id) {
      const m = find(taskId, id);
      return m ? structuredClone(m) : undefined;
    },
    list(taskId) {
      return (byTask.get(taskId) ?? []).map((m) => structuredClone(m));
    },
  };
}

function makeScheduler(overrides = {}) {
  const sessions = [];
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        inputs: [],
        interrupts: [],
        permissionResolutions: [],
        async start() {},
        sendUserText(text) { this.inputs.push(text); },
        sendUserContent() {},
        resolvePermission(id, decision) { this.permissionResolutions.push([id, decision]); },
        async interrupt(kind) { this.interrupts.push(kind); },
        end() {},
      };
      sessions.push(session);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    meetingId: 'meeting-defects',
    defaultBackendId: 'opencode',
    ...overrides,
  });
  return { scheduler, sessions };
}

// #1 (1a): endAll while spawnWorker awaits the delivery proposal must not
// start a backend session for the disposed handle.
test('spawn aborted by endAll during delivery proposal never starts a session', async () => {
  let releasePropose;
  const proposeGate = new Promise((resolve) => { releasePropose = resolve; });
  let proposeEntered = false;
  const harness = {
    async propose() {
      proposeEntered = true;
      await proposeGate;
      return { id: 'd-orphan', spec: { version: 1 } };
    },
    async decide() { return { attempt: 1 }; },
    observe() { return (async function* () { await new Promise(() => {}); })(); },
    async inspect() { return { id: 'd-orphan', status: 'executing', attempt: 1 }; },
    snapshot() { return undefined; },
  };
  const { scheduler, sessions } = makeScheduler({ deliveryHarness: harness });
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Orphan probe', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => proposeEntered, 'spawn did not reach the delivery proposal');
  assert.equal(sessions.length, 0, 'session must not exist before the proposal resolves');

  scheduler.endAll();
  releasePropose();
  await settle();
  assert.equal(sessions.length, 0, 'aborted spawn must not create a backend session');
});

// #2 (1b): a WorkReport arriving after the task terminalized must not revive it.
test('late WorkReport is dropped for a non-running worker', async () => {
  const { scheduler, sessions } = makeScheduler();
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Late report', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'w1')?.status === 'interrupted',
    'worker did not terminalize as interrupted',
  );

  scheduler.submitWorkerReport('w1', report);
  await settle();
  const task = scheduler.snapshot().find((item) => item.id === 'w1');
  assert.equal(task.status, 'interrupted', 'late report must not revive the task');
  assert.equal(task.report, undefined, 'late report must not be claimed');
  scheduler.endAll();
});

// #3 (1c): submit_work_report bound to a stale attempt is dropped; the current
// attempt still enters the delivery pipeline.
test('stale sourceAttempt report is discarded while the current attempt proceeds', async () => {
  const { scheduler, sessions } = makeScheduler();
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Attempt binding', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  scheduler.submitWorkerReport('w1', report, 99);
  await settle();
  const afterStale = scheduler.snapshot().find((task) => task.id === 'w1');
  assert.equal(afterStale.status, 'running', 'stale-attempt report must be a no-op');
  assert.equal(afterStale.report, undefined);

  // The matching attempt enters the pipeline: with no DeliveryHarness the
  // delivery branch terminalizes as failed, proving the report was accepted.
  scheduler.submitWorkerReport('w1', report, 1);
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'w1')?.status === 'failed',
    'current-attempt report did not enter the delivery pipeline',
  );
  scheduler.endAll();
});

// #4a (2b): follow-up channels must reject accepted / in-flight-integration states.
test('queueFollowUp and sendTaskMessage reject terminal and integration states', async () => {
  const { scheduler, sessions } = makeScheduler({ taskMailbox: inMemoryMailbox() });
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Terminal gate', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');
  const handle = scheduler.workers.get('w1');

  handle.status = 'accepted';
  await assert.rejects(
    () => scheduler.queueFollowUp('w1', 'more work'),
    /createFinalDeliveryRework/,
    'accepted task must route rework through createFinalDeliveryRework',
  );
  await assert.rejects(() => scheduler.sendTaskMessage('w1', 'more work'), /createFinalDeliveryRework/);

  handle.status = 'integration-queued';
  await assert.rejects(
    () => scheduler.queueFollowUp('w1', 'more work'),
    /integration/,
    'in-flight integration must reject follow-ups until it settles',
  );
  handle.status = 'integrating';
  await assert.rejects(() => scheduler.sendTaskMessage('w1', 'more work'), /integration/);

  handle.status = 'running';
  scheduler.endAll();
});

// #4b (2a): a delivery observer from a superseded attempt must detach instead
// of stomping the new attempt with stale views.
test('stale delivery observer detaches after a follow-up attempt reset', async () => {
  const queues = new Map();
  let proposeCount = 0;
  const inspectCalls = [];
  const harness = {
    async propose() {
      proposeCount += 1;
      return { id: `d-${proposeCount}`, spec: { version: 1 } };
    },
    async decide() { return { attempt: proposeCount }; },
    observe(id) {
      const queue = { pending: 0, notify: null };
      queues.set(id, queue);
      return (async function* () {
        for (;;) {
          if (queue.pending === 0) {
            await new Promise((resolve) => { queue.notify = resolve; });
            queue.notify = null;
          }
          while (queue.pending > 0) {
            queue.pending -= 1;
            yield { kind: 'status-changed' };
          }
        }
      })();
    },
    async inspect(id) {
      inspectCalls.push(id);
      // A stale observer applying this would visibly stomp the handle.
      return { id, status: 'accepted', attempt: 99, candidate: null };
    },
    snapshot() { return undefined; },
  };
  const { scheduler, sessions } = makeScheduler({
    deliveryHarness: harness,
    taskMailbox: inMemoryMailbox(),
  });
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Observer race', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');
  assert.equal(scheduler.workers.get('w1').deliveryId, 'd-1');

  // Attempt 1 fails; a follow-up forks attempt 2 with a fresh delivery.
  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'failed', code: 'worker-runtime-error', message: 'boom', retryable: true },
  });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'w1')?.status === 'failed',
    'attempt 1 did not fail',
  );
  await scheduler.queueFollowUp('w1', 'try again');
  await waitFor(() => sessions.length === 2, 'follow-up attempt was not spawned');
  await waitFor(() => scheduler.workers.get('w1').deliveryId === 'd-2', 'attempt 2 delivery missing');

  // Wake the stale d-1 observer: the ownership guard must break the loop
  // before inspect() can stomp the new attempt.
  const staleQueue = queues.get('d-1');
  staleQueue.pending += 1;
  staleQueue.notify?.();
  await settle();
  assert.equal(inspectCalls.includes('d-1'), false, 'stale observer must not inspect the old delivery');
  const task = scheduler.snapshot().find((item) => item.id === 'w1');
  assert.equal(task.status, 'running', 'new attempt must keep its own status');
  assert.equal(task.attempt, 2);
  scheduler.endAll();
});

// #5 (2c): a settle returning after the task was closed must not apply the
// stale view or trigger automatic rework.
test('late delivery settle is ignored after the task was failed closed', async () => {
  let releaseSettle;
  const settleGate = new Promise((resolve) => { releaseSettle = resolve; });
  const harness = {
    async propose() { return { id: 'd-1', spec: { version: 1 } }; },
    async decide() { return { attempt: 1 }; },
    observe() { return (async function* () { await new Promise(() => {}); })(); },
    async inspect() { return { id: 'd-1', status: 'executing', attempt: 1 }; },
    async submitExternalReport() { return settleGate; },
    snapshot() { return undefined; },
  };
  const { scheduler, sessions } = makeScheduler({ deliveryHarness: harness });
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Late settle', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'w1')?.status === 'verifying',
    'worker did not enter verifying',
  );

  // Equivalent of the sweepParked fail-close while the settle is in flight.
  const handle = scheduler.workers.get('w1');
  scheduler.disposeWorker(handle, 'failed', 'parked fail-close');
  releaseSettle({ id: 'd-1', status: 'reworking', attempt: 1 });
  await settle();

  const task = scheduler.snapshot().find((item) => item.id === 'w1');
  assert.equal(task.status, 'failed', 'late settle must not overwrite the terminal state');
  assert.equal(task.attempt, 1, 'late settle must not fork an automatic rework attempt');
  assert.equal(sessions.length, 1, 'no rework session may be spawned by a stale settle');
  scheduler.endAll();
});

// #6 (2d): a trailing transport error from the released session must not fail
// a parked delivery.
test('error event is ignored for a parked worker without a session', async () => {
  const harness = {
    async propose() { return { id: 'd-1', spec: { version: 1 } }; },
    async decide() { return { attempt: 1 }; },
    observe() { return (async function* () { await new Promise(() => {}); })(); },
    async inspect() { return { id: 'd-1', status: 'executing', attempt: 1 }; },
    // Never settles: the worker stays parked in 'verifying'.
    submitExternalReport() { return new Promise(() => {}); },
    snapshot() { return undefined; },
  };
  const { scheduler, sessions } = makeScheduler({ deliveryHarness: harness });
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Parked error', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'w1')?.status === 'verifying',
    'worker did not enter verifying',
  );
  assert.equal(scheduler.workers.get('w1').session, null, 'parked worker must have released its session');

  scheduler.onWorkerEvent('w1', { kind: 'error', error: 'late transport error' });
  await settle();
  assert.equal(
    scheduler.snapshot().find((task) => task.id === 'w1')?.status,
    'verifying',
    'a parked delivery must survive a trailing transport error',
  );
  scheduler.endAll();
});

// #7 (3a): a permission resolution routes only to the registered owner; the
// same request id on another worker keeps its timer and pending fingerprint.
test('permission resolution is namespaced to the owning worker', async () => {
  const { scheduler, sessions } = makeScheduler();
  assert.deepEqual(scheduler.installPlan([
    { id: 'a', title: 'Worker A', prompt: 'do a', deps: [] },
    { id: 'b', title: 'Worker B', prompt: 'do b', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 2, 'both workers were not spawned');
  const hA = scheduler.workers.get('a');
  const hB = scheduler.workers.get('b');

  hA.pendingAskFingerprints = new Map([['req-1', 'fp-a']]);
  hB.pendingAskFingerprints = new Map([['req-1', 'fp-b']]);
  scheduler.askOwnersByRequestId.set('req-1', new Set(['a']));
  scheduler.armPermissionTimeout(hA, 'req-1');
  scheduler.armPermissionTimeout(hB, 'req-1');
  assert.equal(scheduler.permissionTimers.has('a:req-1'), true);
  assert.equal(scheduler.permissionTimers.has('b:req-1'), true);

  scheduler.resolvePermissionInAny('req-1', 'allow');

  assert.deepEqual(hA.session.permissionResolutions, [['req-1', 'allow']]);
  assert.deepEqual(hB.session.permissionResolutions, [], 'non-owner session must not be resolved');
  assert.equal(hA.approvedAskFingerprints?.has('fp-a'), true, 'owner fingerprint must be remembered');
  assert.equal(hB.pendingAskFingerprints.has('req-1'), true, 'non-owner ask must stay pending');
  assert.equal(scheduler.permissionTimers.has('a:req-1'), false, 'owner timer must be cleared');
  assert.equal(scheduler.permissionTimers.has('b:req-1'), true, 'non-owner timer must survive');
  assert.equal(scheduler.askOwnersByRequestId.has('req-1'), false, 'owner registration is consumed');
  scheduler.endAll();
  assert.equal(scheduler.permissionTimers.size, 0, 'endAll must drain remaining permission timers');
});

// #8 (3b): interruptAll clears an in-flight steer so the backend's
// ended(interrupted) terminalizes the task instead of restarting the turn.
test('interruptAll wins over an in-flight steer', async () => {
  let releaseSteerInterrupt;
  const { scheduler, sessions } = makeScheduler({
    taskMailbox: inMemoryMailbox(),
    sessionFactory(opts) {
      const session = {
        opts,
        inputs: [],
        interrupts: [],
        async start() {},
        sendUserText(text) { this.inputs.push(text); },
        sendUserContent() {},
        resolvePermission() {},
        interrupt(kind) {
          this.interrupts.push(kind);
          if (kind === 'steer') {
            return new Promise((resolve) => { releaseSteerInterrupt = resolve; });
          }
          return Promise.resolve();
        },
        end() {},
      };
      sessions.push(session);
      return session;
    },
  });
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Steer race', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  // First progress boundary consumes the delegate ack so steer goes live.
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: 'working' } });
  await waitFor(() => scheduler.workers.get('w1').pendingDelegateAck === false, 'delegate ack not consumed');

  const steerPromise = scheduler.steerTask('w1', 'change course');
  await waitFor(() => sessions[0].interrupts.includes('steer'), 'steer interrupt not issued');

  scheduler.interruptAll();
  assert.equal(scheduler.steeringMessageByWorker.has('w1'), false, 'interruptAll must clear the steer marker');
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'w1')?.status === 'interrupted',
    'user interrupt did not terminalize the task',
  );

  releaseSteerInterrupt();
  const steerResult = await steerPromise;
  assert.deepEqual(steerResult, { ok: true, queued: true }, 'resumed steer must queue, not restart');
  assert.equal(
    sessions[0].inputs.some((text) => text.startsWith('(plan update)')),
    false,
    'steer text must not be sent into an interrupted session',
  );
  assert.equal(scheduler.snapshot().find((task) => task.id === 'w1')?.status, 'interrupted');
  scheduler.endAll();
});

// #9 (4a): a queued follow-up from attempt N is delivered on attempt N+1,
// while a queued protocol-correction copy never crosses attempts.
test('queued follow-ups carry over to the next attempt; recovery messages do not', async () => {
  const mailbox = inMemoryMailbox();
  const { scheduler, sessions } = makeScheduler({ taskMailbox: mailbox });
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Mailbox carry-over', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  // Queued during attempt 1, never delivered (no result boundary follows).
  await scheduler.queueFollowUp('w1', 'leftover instruction');

  // Real protocol correction: turn ends without a report → recovery follow-up.
  sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
  const recovery = await waitFor(
    () => mailbox.list('w1').find((m) => m.kind === 'follow-up' && m.status === 'delivered'),
    'protocol correction was not enqueued',
  );
  assert.ok(recovery.payload.text.startsWith(PROTOCOL_CORRECTION_PREFIX));
  // A queued copy of the correction stuck from attempt 1 must never cross.
  const recoveryCopy = await mailbox.enqueue({
    taskId: 'w1',
    attempt: 1,
    sender: 'coordinator',
    kind: 'follow-up',
    payload: { text: recovery.payload.text },
  });

  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'failed', code: 'worker-runtime-error', message: 'boom', retryable: true },
  });
  await waitFor(
    () => scheduler.snapshot().find((task) => task.id === 'w1')?.status === 'failed',
    'attempt 1 did not fail',
  );

  await scheduler.queueFollowUp('w1', 'fresh follow-up');
  await waitFor(() => sessions.length === 2, 'follow-up attempt was not spawned');
  await waitFor(() => sessions[1].inputs.length >= 1, 'initial prompt was not sent');
  assert.ok(
    sessions[1].inputs[0].includes('leftover instruction'),
    'attempt-1 leftover must ride the attempt-2 initial prompt',
  );

  // Result boundary drives the next queued follow-up (the fresh attempt-2 one).
  sessions[1].opts.emit({ kind: 'message', message: { type: 'result' } });
  await waitFor(
    () => sessions[1].inputs.some((text) => text.includes('fresh follow-up')),
    'fresh follow-up was not delivered at the result boundary',
  );

  assert.equal(
    mailbox.list('w1').find((m) => m.id === recoveryCopy.id).status,
    'queued',
    'stale protocol correction must never be delivered across attempts',
  );
  assert.equal(
    sessions[1].inputs.some((text) => text.includes(PROTOCOL_CORRECTION_PREFIX)),
    false,
    'attempt 2 must not receive the attempt-1 correction text',
  );
  scheduler.endAll();
});

// #10 (4b): eventSeq survives snapshot → restoreTasks so post-recovery events
// continue the monotonic sequence.
test('snapshot and restoreTasks round-trip the worker event sequence', async () => {
  const { scheduler, sessions } = makeScheduler();
  assert.deepEqual(scheduler.installPlan([
    { id: 'w1', title: 'Seq persistence', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  for (let i = 0; i < 3; i += 1) {
    sessions[0].opts.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: `step ${i + 1}` } });
  }
  await waitFor(() => scheduler.workers.get('w1').eventSeq === 3, 'event sequence did not advance');

  const snap = scheduler.snapshot();
  assert.equal(snap.find((task) => task.id === 'w1').eventSeq, 3, 'snapshot must persist eventSeq');
  scheduler.endAll();

  const { scheduler: restored } = makeScheduler();
  restored.restoreTasks(snap);
  assert.equal(restored.workers.get('w1').eventSeq, 3, 'restore must resume the persisted eventSeq');
  restored.endAll();
});
