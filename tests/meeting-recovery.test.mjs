import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';

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
    const deadline = Date.now() + 2_000;
    while (!events.some((event) => (
      event.event.kind === 'worker-spawned' && event.event.workerId === 'retry-task'
    ))) {
      if (Date.now() > deadline) assert.fail('recovered worker-spawned event did not become durable');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
  const cwd = mkdtempSync(join(tmpdir(), 'ahastation-journal-review-'));
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'ahastation-journal-worktrees-'));
  execFileSync('git', ['init'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'AhaStation Test'], { cwd });
  writeFileSync(join(cwd, 'README.md'), '# Base\n');
  execFileSync('git', ['add', '--', 'README.md'], { cwd });
  execFileSync('git', ['commit', '-m', 'base'], { cwd });
  const orchestrator = new Orchestrator({
    emit(event) { events.push(event); },
    cwd,
    meetingId,
    workspaceManager: new TaskWorkspaceManager(meetingId, cwd, { worktreeRoot }),
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
    await orchestrator.start();
    await orchestrator.installPlan([{
      id: 'journal-task',
      title: 'Journal task',
      prompt: 'produce evidence',
      deps: [],
      executorBackendId: 'claude-code',
      writePaths: ['src'],
      executionProfile: {
        schemaVersion: 1,
        backendId: 'claude-code',
        workMode: 'balanced',
        contextMode: 'meeting-summary',
        timeoutMs: 1_800_000,
        maxTokenBudget: 200_000,
      },
      contextSelection: {
        mode: 'meeting-summary',
        messageIds: [],
        decisionIds: [],
        dependencyTaskIds: [],
        attachmentIds: [],
      },
      workspaceMode: 'git-worktree',
      authorityRequest: {
        writePaths: ['src'],
        toolKinds: ['read', 'write'],
        workingDirectories: ['.'],
        commands: [],
        environmentKeys: [],
        maxCommandTimeoutMs: 1_800_000,
        networkHosts: [],
      },
    }]);
    let workerSession;
    while (!workerSession) {
      workerSession = sessions.find((session) => session.opts.cwd !== cwd);
      if (!workerSession) await new Promise((resolve) => setImmediate(resolve));
    }
    mkdirSync(join(workerSession.opts.cwd, 'src'), { recursive: true });
    writeFileSync(join(workerSession.opts.cwd, 'src', 'result.ts'), 'export const result = true;\n');
    workerSession.opts.emit({
      kind: 'worker-signal',
      signal: { kind: 'progress', message: 'started' },
    });
    workerSession.opts.emit({
      kind: 'worker-signal',
      signal: {
        kind: 'delivery',
        report: {
          status: 'completed',
          summary: 'done',
          files: [{ path: 'src/result.ts', action: 'created' }],
          tests: [],
          unresolved: [],
        },
      },
    });
    // Freezing and committing an exact delivery candidate can take several
    // seconds on Windows worktrees. This is an integration timeout, not a
    // scheduler polling budget.
    const reviewDeadline = Date.now() + 15_000;
    while (!events.some((event) => (
      event.event.kind === 'delivery-status'
      && event.event.delivery.status === 'coordinator-reviewing'
    ))) {
      if (Date.now() > reviewDeadline) {
        const journal = await MeetingRepository.replay(meetingId);
        const deliveryStatuses = events
          .filter((event) => event.event.kind === 'delivery-status')
          .map((event) => event.event.delivery);
        assert.fail(
          `Coordinator review event did not arrive; delivery=${JSON.stringify(deliveryStatuses)}`
          + ` journal=${JSON.stringify(journal.map((event) => event.type))}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const reviewJournal = await MeetingRepository.replay(meetingId);
    const requested = reviewJournal.find((event) => event.type === 'coordinator-review-requested');
    assert.ok(requested);
    const reviewId = requested.payload.data.session.id;
    const chunk = orchestrator.getDeliveryReviewChunk(reviewId);
    assert.ok(chunk);
    await orchestrator.submitDeliveryChunkReview(reviewId, {
      chunkId: chunk.id,
      chunkHash: chunk.hash,
      verdict: 'passed',
      findings: [],
    });
    await orchestrator.completeDeliveryReview(reviewId);
    const acceptanceDeadline = Date.now() + 15_000;
    while (!events.some((event) => (
      event.event.kind === 'delivery-status'
      && event.event.delivery.status === 'awaiting-delivery-acceptance'
    ))) {
      if (Date.now() > acceptanceDeadline) assert.fail('renderer delivery event did not arrive');
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
    await rm(worktreeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});
