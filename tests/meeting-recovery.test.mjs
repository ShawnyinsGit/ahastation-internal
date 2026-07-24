import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';

function fakeSessionFactory() {
  return {
    async start() {}, end() {}, sendUserText() {}, sendUserContent() {},
    resolvePermission() {}, async interrupt() {},
    snapshot() { return { protocol: 'codex-app-server', sessionId: 'thread-recovered' }; },
  };
}

test('recoverable snapshots convert running tasks to interrupted without replaying them', async () => {
  const meetingId = `recovery-${randomUUID()}`;
  const repository = new MeetingRepository(meetingId);
  try {
    await repository.snapshot({
      status: 'active', cwd: '/workspace',
      planVersion: 7,
      hosts: [{ id: 'default', backendId: 'codex', backendSession: {
        protocol: 'codex-app-server', sessionId: 'thread-1',
      } }],
      tasks: [{ id: 'task-1', title: 'Running task', prompt: 'do it', status: 'running', deps: [] }],
    });
    const recovered = (await MeetingRepository.listRecoverable()).find((entry) => entry.meetingId === meetingId);
    assert.equal(recovered.seq, 0);
    assert.equal(recovered.state.status, 'recovering');
    assert.equal(recovered.state.planVersion, 7);
    assert.equal(recovered.state.tasks[0].status, 'interrupted');
    assert.equal(recovered.state.hosts[0].backendSession.sessionId, 'thread-1');
  } finally {
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('recovered repositories continue the durable event sequence', async () => {
  const meetingId = `recovery-${randomUUID()}`;
  try {
    const original = new MeetingRepository(meetingId);
    await original.append('meeting-created', {});
    await original.snapshot({ status: 'active', cwd: '/tmp', tasks: [] });
    const recovered = (await MeetingRepository.listRecoverable()).find((entry) => entry.meetingId === meetingId);
    const resumed = new MeetingRepository(meetingId, recovered.seq);
    await resumed.append('meeting-recovered', {});
    assert.deepEqual((await MeetingRepository.replay(meetingId)).map((event) => event.seq), [1, 2]);
  } finally {
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('user-confirmed recovery projects interrupted tasks but spawns no workers', async () => {
  const events = [];
  const meetingId = `recovery-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (event) => events.push(event),
    cwd: '/tmp',
    meetingId,
    sessionFactory: fakeSessionFactory,
    recoveredPlanVersion: 7,
    recoveredTasks: [{ id: 'task-1', title: 'Interrupted task', prompt: 'do it', status: 'interrupted', deps: [] }],
  });
  try {
    await orchestrator.start();
    const plan = events.find((event) => event.event.kind === 'plan-updated');
    assert.equal(plan.event.plan.version, 7);
    assert.equal(plan.event.plan.nodes[0].status, 'interrupted');
    assert.equal(events.some((event) => event.event.kind === 'worker-spawned'), false);
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('the user can explicitly resolve or restart an interrupted task', async () => {
  const events = [];
  const meetingId = `recovery-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (event) => events.push(event), cwd: '/tmp', meetingId,
    sessionFactory: fakeSessionFactory,
    recoveredTasks: [
      { id: 'abandon-task', title: 'Abandoned task', prompt: 'done', status: 'interrupted', deps: [] },
      { id: 'retry-task', title: 'Retry task', prompt: 'do it again', status: 'interrupted', deps: [] },
    ],
  });
  try {
    await orchestrator.start();
    assert.deepEqual(await orchestrator.resolveRecoveredTask('abandon-task', 'abandon'), { ok: true });
    assert.deepEqual(await orchestrator.resolveRecoveredTask('retry-task', 'retry'), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(events.some((event) => (
      event.event.kind === 'worker-spawned' && event.event.workerId === 'retry-task'
    )), true);
    const latestPlan = events.filter((event) => event.event.kind === 'plan-updated').at(-1);
    assert.equal(latestPlan.event.plan.nodes.some((node) => node.id === 'retry-task'), true);
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('canonical WorkerEvent and delivery state are journaled before renderer emission', async () => {
  const events = [];
  const sessions = [];
  const meetingId = `journal-first-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit(event) { events.push(event); },
    cwd: '/tmp',
    meetingId,
    sessionFactory(opts) {
      const session = {
        opts,
        async start() {},
        end() {},
        sendUserText() {},
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
      };
      sessions.push(session);
      return session;
    },
  });
  try {
    await orchestrator.installPlan([{
      id: 'journal-task',
      title: 'Journal task',
      prompt: 'produce evidence',
      deps: [],
    }]);
    while (sessions.length === 0) await new Promise((resolve) => setImmediate(resolve));
    sessions[0].opts.emit({
      kind: 'worker-signal',
      signal: { kind: 'progress', message: 'started' },
    });
    sessions[0].opts.emit({
      kind: 'worker-signal',
      signal: {
        kind: 'delivery',
        report: {
          status: 'completed',
          summary: 'done',
          files: [],
          tests: [],
          unresolved: [],
        },
      },
    });
    const deadline = Date.now() + 2_000;
    while (!events.some((event) => (
      event.event.kind === 'delivery-status'
      && event.event.delivery.status === 'awaiting-delivery-acceptance'
    ))) {
      if (Date.now() > deadline) assert.fail('renderer delivery event did not arrive');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const journal = await MeetingRepository.replay(meetingId);
    assert.equal(journal.some((event) => (
      event.type === 'event:worker-event'
      && event.payload.event.kind === 'worker-event'
      && event.payload.event.event.payload.kind === 'progress'
    )), true);
    assert.equal(journal.some((event) => (
      event.type === 'event:delivery-status'
      && event.payload.event.kind === 'delivery-status'
      && event.payload.event.delivery.status === 'awaiting-delivery-acceptance'
    )), true);
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});
