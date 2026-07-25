import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

// recordWorkerQuestion enqueues durably but only delivers when a Coordinator
// session exists. If the Coordinator was null at ask time the question stayed
// 'queued' forever - only follow-up/instruction/steer are re-driven on
// activity. redeliverPendingWorkerQuestions closes that gap on Coordinator
// (re)start.

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

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test('redeliverPendingWorkerQuestions flushes asks queued while the Coordinator was away', async () => {
  const sessions = [];
  const coordinator = { inputs: [], sendUserText(text) { this.inputs.push(text); } };
  let talker = null;
  const mailbox = inMemoryMailbox();
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
    getTalker: () => talker,
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    meetingId: 'question-redeliver',
    defaultBackendId: 'opencode',
    taskMailbox: mailbox,
  });

  assert.deepEqual(scheduler.installPlan([
    { id: 'worker-1', title: 'Worker 1', prompt: 'do the work', deps: [] },
  ]), { ok: true });
  await waitFor(() => sessions.length === 1, 'worker was not spawned');

  // Coordinator unavailable at ask time -> question is durable but undelivered.
  const message = await scheduler.recordWorkerQuestion('worker-1', 'which branch?');
  assert.equal(message.status, 'queued');
  assert.equal(coordinator.inputs.length, 0, 'nothing was delivered while the Coordinator was absent');

  // Coordinator comes back; redelivery flushes the queued question.
  talker = coordinator;
  await scheduler.redeliverPendingWorkerQuestions();

  assert.ok(
    coordinator.inputs.some((text) => text.includes('which branch?')),
    'the queued question was redelivered to the Coordinator',
  );
  const after = mailbox.list('worker-1').find((m) => m.id === message.id);
  assert.equal(after.status, 'delivered');

  // Idempotent: a second redelivery does not re-send an already-delivered question.
  const beforeCount = coordinator.inputs.length;
  await scheduler.redeliverPendingWorkerQuestions();
  assert.equal(coordinator.inputs.length, beforeCount, 'a delivered question is not re-sent');

  scheduler.endAll();
});
