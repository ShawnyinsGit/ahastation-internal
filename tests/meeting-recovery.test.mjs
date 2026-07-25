import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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

function explicitReadOnlyTask(overrides = {}) {
  return {
    id: 'read-only-task',
    title: 'Read-only recovery',
    prompt: 'inspect the repository',
    status: 'running',
    deps: [],
    workspaceMode: 'read-only',
    authorityRequest: {
      writePaths: [],
      toolKinds: ['read', 'search', 'git-read'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
    ...overrides,
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
    assert.deepEqual(await orchestrator.resolveRecoveredTask('abandon-task', 'abandon-task'), { ok: true });
    assert.deepEqual(await orchestrator.resolveRecoveredTask('retry-task', 'retry-attempt'), { ok: true });
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
    const acceptanceDeadline = Date.now() + 30_000;
    while (!events.some((event) => (
      event.event.kind === 'delivery-status'
      && event.event.delivery.status === 'accepted'
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
      && event.payload.event.delivery.status === 'accepted'
    )), true);
    await orchestrator.snapshotActiveMeeting();
    const snapshot = JSON.parse(
      readFileSync(`/tmp/meetings/${meetingId}/snapshot.json`, 'utf8'),
    );
    assert.equal(snapshot.schemaVersion, 3);
    assert.equal(snapshot.state.coordinatorHostId, 'default');
    assert.equal(snapshot.state.planVersion, 1);
    assert.equal(snapshot.state.reviewSessions.length, 1);
    assert.equal(snapshot.state.reviewSessions[0].coverage.complete, true);
    assert.equal(
      snapshot.state.reviewSessions[0].coverage.reviewedChunks,
      snapshot.state.reviewSessions[0].coverage.totalChunks,
    );
    assert.equal(snapshot.state.taskMailboxes[0].taskId, 'journal-task');
    assert.equal(snapshot.state.taskMailboxes[0].cursor, 0);
    assert.equal(
      snapshot.state.integrationQueue.durableHead,
      snapshot.state.tasks[0].delivery.integration.resultRevision,
    );
  } finally {
    await orchestrator.end();
    await rm(worktreeRoot, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('recovery sequence advances past journal events written after the last snapshot', async () => {
  const meetingId = `recovery-tail-${randomUUID()}`;
  try {
    const original = new MeetingRepository(meetingId);
    await original.append('meeting-created', {});
    await original.snapshot({ status: 'active', cwd: '/tmp', tasks: [] });
    await original.append('event:plan-updated', { version: 2 });
    const recovered = (await MeetingRepository.listRecoverable())
      .find((entry) => entry.meetingId === meetingId);
    assert.equal(recovered.seq, 2);
    const resumed = new MeetingRepository(meetingId, recovered.seq);
    await resumed.append('meeting-recovered', {});
    assert.deepEqual(
      (await MeetingRepository.replay(meetingId)).map((event) => event.seq),
      [1, 2, 3],
    );
  } finally {
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('a durable accepted task never regresses because of a late plan event', async () => {
  const meetingId = `recovery-monotonic-${randomUUID()}`;
  try {
    const repository = new MeetingRepository(meetingId);
    await repository.snapshot({
      status: 'active',
      cwd: '/tmp',
      tasks: [{ id: 'task-a', title: 'A', prompt: 'a', status: 'running', deps: [] }],
    });
    await repository.append('event:plan-updated', {
      event: { kind: 'plan-updated', plan: { version: 2, nodes: [{ id: 'task-a', status: 'accepted' }] } },
    });
    await repository.append('event:plan-updated', {
      event: { kind: 'plan-updated', plan: { version: 1, nodes: [{ id: 'task-a', status: 'running' }] } },
    });
    const recovered = (await MeetingRepository.listRecoverable())
      .find((entry) => entry.meetingId === meetingId);
    assert.equal(recovered.state.tasks[0].status, 'accepted');
  } finally {
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('only explicit read-only running tasks auto-resume after durable authorization', async () => {
  const sessions = [];
  const events = [];
  const meetingId = `recovery-read-only-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit: (event) => events.push(event),
    cwd: '/tmp',
    meetingId,
    sessionFactory(opts) {
      sessions.push(opts);
      return fakeSessionFactory();
    },
    recoveredTasks: [explicitReadOnlyTask()],
  });
  try {
    await orchestrator.start();
    const deadline = Date.now() + 2_000;
    while (!events.some((event) => (
      event.event.kind === 'worker-spawned'
      && event.event.workerId === 'read-only-task'
    ))) {
      if (Date.now() > deadline) assert.fail('read-only task did not auto-resume');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(sessions.length, 2, 'one Host and one read-only Worker are created');
    const journal = await MeetingRepository.replay(meetingId);
    const authorization = journal.find(
      (event) => event.type === 'recovered-task-resolution-authorized',
    );
    const spawned = journal.find((event) => (
      event.type === 'event:worker-spawned'
      && event.payload.event.workerId === 'read-only-task'
    ));
    assert.ok(authorization);
    assert.equal(authorization.payload.action, 'continue-read-only');
    assert.equal(authorization.payload.actor, 'system-auto-read-only');
    assert.ok(spawned);
    assert.ok(authorization.seq < spawned.seq);
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('side-effecting recovered tasks send no Backend prompt before user confirmation', async () => {
  const sessions = [];
  const meetingId = `recovery-side-effect-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: '/tmp',
    meetingId,
    sessionFactory(opts) {
      sessions.push(opts);
      return fakeSessionFactory();
    },
    recoveredTasks: [explicitReadOnlyTask({
      id: 'write-task',
      workspaceMode: 'git-worktree',
      authorityRequest: {
        writePaths: ['src'],
        toolKinds: ['read', 'write', 'execute'],
        workingDirectories: ['.'],
        commands: [['npm', 'test']],
        environmentKeys: [],
        maxCommandTimeoutMs: 1_800_000,
        networkHosts: [],
      },
    })],
  });
  try {
    await orchestrator.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(sessions.length, 1, 'only the Host session is created');
    const journal = await MeetingRepository.replay(meetingId);
    assert.equal(
      journal.some((event) => event.type === 'recovered-task-resolution-authorized'),
      false,
    );
    assert.equal(
      journal.some((event) => event.type === 'event:worker-spawned'),
      false,
    );
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

// --- Snapshot durability: rename-first replace, orphan tmp cleanup, and
// recovery fallbacks (tmp projection / journal rebuild). ---

const snapshotTmps = (dir) => readdirSync(dir).filter((name) => /^snapshot\.json\..+\.tmp$/.test(name));

test('snapshot replaces atomically and reaps only stale orphan tmp files', async () => {
  const meetingId = `snapshot-tmp-${randomUUID()}`;
  const dir = `/tmp/meetings/${meetingId}`;
  try {
    const repository = new MeetingRepository(meetingId);
    await repository.snapshot({ status: 'active', cwd: '/workspace', hosts: [], tasks: [] });
    // rename-first: the tmp was consumed by the rename, never left behind.
    assert.deepEqual(snapshotTmps(dir), []);

    // A stale tmp from a crashed previous run vs. a fresh concurrent one.
    const staleTmp = `${dir}/snapshot.json.111.tmp`;
    const freshTmp = `${dir}/snapshot.json.222.tmp`;
    writeFileSync(staleTmp, '{}');
    utimesSync(staleTmp, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    writeFileSync(freshTmp, '{}');

    // Replacing an existing snapshot.json must succeed (rename-first path)
    // and reap only the stale orphan.
    await repository.snapshot({ status: 'active', cwd: '/workspace', hosts: [], tasks: [], planVersion: 2 });
    const persisted = JSON.parse(readFileSync(`${dir}/snapshot.json`, 'utf8'));
    assert.equal(persisted.state.planVersion, 2);
    assert.equal(existsSync(staleTmp), false, 'stale orphan tmp must be reaped');
    assert.equal(existsSync(freshTmp), true, 'a fresh tmp may belong to a live writer');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listRecoverable falls back to the newest snapshot tmp when the rename never landed', async () => {
  const meetingId = `snapshot-orphan-${randomUUID()}`;
  const dir = `/tmp/meetings/${meetingId}`;
  try {
    // Crash window reproduction: a fully serialized tmp, no snapshot.json.
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/snapshot.json.4242.tmp`, JSON.stringify({
      schemaVersion: 3,
      seq: 5,
      state: {
        status: 'active',
        cwd: '/workspace',
        hosts: [],
        tasks: [{ id: 'task-1', title: 'Orphan', prompt: 'do it', status: 'running', deps: [] }],
      },
    }));
    const recovered = (await MeetingRepository.listRecoverable()).find((entry) => entry.meetingId === meetingId);
    assert.ok(recovered, 'the tmp projection must make the meeting recoverable');
    assert.equal(recovered.seq, 5);
    assert.equal(recovered.state.status, 'recovering');
    assert.equal(recovered.state.tasks[0].status, 'interrupted');
    // The tmp is the sole surviving projection: scanning must not delete it.
    assert.deepEqual(snapshotTmps(dir), ['snapshot.json.4242.tmp']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listRecoverable rebuilds an active meeting from the journal when no projection exists', async () => {
  const meetingId = `journal-fallback-${randomUUID()}`;
  const dir = `/tmp/meetings/${meetingId}`;
  try {
    // Crash before the first snapshot save: only the journal exists.
    const repository = new MeetingRepository(meetingId);
    await repository.append('meeting-created', { cwd: '/workspace' });
    await repository.append('event:plan-updated', {
      event: {
        kind: 'plan-updated',
        plan: {
          nodes: [{ id: 'task-1', title: 'Journaled', prompt: 'do it', status: 'running', deps: [] }],
        },
      },
    });
    assert.equal(existsSync(`${dir}/snapshot.json`), false);

    const recovered = (await MeetingRepository.listRecoverable()).find((entry) => entry.meetingId === meetingId);
    assert.ok(recovered, 'journal-only meetings must still be recoverable');
    assert.equal(recovered.state.status, 'recovering');
    assert.equal(recovered.state.cwd, '/workspace');
    assert.equal(recovered.seq, 2);
    assert.equal(recovered.state.tasks[0].id, 'task-1');
    assert.equal(recovered.state.tasks[0].status, 'interrupted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a journal without a cwd anchor is not offered for recovery', async () => {
  const meetingId = `journal-anchorless-${randomUUID()}`;
  const dir = `/tmp/meetings/${meetingId}`;
  try {
    const repository = new MeetingRepository(meetingId);
    await repository.append('meeting-created', {});
    const recovered = (await MeetingRepository.listRecoverable()).find((entry) => entry.meetingId === meetingId);
    assert.equal(recovered, undefined, 'no cwd anchor means no usable recovery state');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
