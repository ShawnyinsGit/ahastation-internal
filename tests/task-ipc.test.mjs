import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TaskIpcService,
  projectRendererTaskEvents,
} from '../dist-electron/ipc/tasks.js';

function event(seq, type, data, options = {}) {
  return {
    id: options.id ?? `event-${seq}`,
    seq,
    ts: 1_000 + seq,
    meetingId: 'meeting-a',
    type,
    payload: {
      schemaVersion: 1,
      taskId: options.taskId ?? 'task-a',
      attempt: options.attempt ?? 1,
      data,
    },
  };
}

function taskMessage(seq, text = `message-${seq}`) {
  return {
    schemaVersion: 1,
    id: `message-${seq}`,
    seq,
    taskId: 'task-a',
    attempt: 1,
    sender: 'coordinator',
    kind: 'follow-up',
    payload: { text },
    status: 'queued',
    timestamp: 2_000 + seq,
  };
}

function createFixture() {
  const events = [
    event(2, 'task-authority-compiled', {
      grantHash: 'a'.repeat(64),
      authorityGrant: {
        allowedToolKinds: ['read', 'execute'],
        writePaths: ['src/secret.ts'],
        allowedCommands: [['npm', 'test']],
        allowedNetworkHosts: ['internal.example'],
        allowedEnvironmentKeys: ['SECRET_TOKEN'],
        expiresAt: 99_999,
      },
    }),
    event(5, 'task-message-enqueued', taskMessage(1, 'Bearer secret-token-value')),
    event(8, 'task-message-delivered', {
      messageId: 'message-1',
      messageSeq: 1,
    }),
  ];
  const listeners = new Set();
  const calls = [];
  let raceEvent = null;
  let durableRecord = null;
  let projectionDiagnostics = [];
  let reviewTaskId = 'task-a';
  const task = {
    id: 'task-a',
    title: 'Task A',
    prompt: 'Implement login',
    deps: [],
    status: 'running',
    executorBackendId: 'codex',
    attempt: 1,
    startedAt: 123,
    executionProfile: {
      schemaVersion: 1,
      backendId: 'codex',
      workMode: 'balanced',
      contextMode: 'meeting-summary',
      timeoutMs: 30_000,
      maxTokenBudget: 10_000,
    },
    authorityGrant: {
      allowedToolKinds: ['read', 'execute'],
      writePaths: ['src/secret.ts'],
      allowedCommands: [['npm', 'test']],
      allowedNetworkHosts: ['internal.example'],
      allowedEnvironmentKeys: ['SECRET_TOKEN'],
      expiresAt: 99_999,
      workspaceRoot: 'C:/private/worktree',
    },
    workspace: {
      kind: 'git-worktree',
      cwd: 'C:/private/worktree',
      branch: 'task-a',
      sourceRevision: 'abc123',
      lockKeys: ['C:/private/worktree/src'],
      managed: true,
    },
  };
  const orchestrator = {
    async getTaskInspectorSource(taskId) {
      if (taskId !== task.id) return null;
      return {
        meetingId: 'meeting-a',
        task,
        record: structuredClone(durableRecord),
        diagnostics: structuredClone(projectionDiagnostics),
        mailbox: [taskMessage(1, 'Bearer secret-token-value')],
        events: structuredClone(events),
      };
    },
    async replayMeetingJournal() {
      if (raceEvent) {
        const pending = raceEvent;
        raceEvent = null;
        events.push(pending);
        for (const listener of listeners) listener(structuredClone(pending));
      }
      return structuredClone(events);
    },
    subscribeMeetingJournal(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async queueTaskFollowUp(taskId, text) {
      calls.push(['follow-up', taskId, text]);
      return taskMessage(2, text);
    },
    async steerWorker(taskId, text) {
      calls.push(['steer', taskId, text]);
      return { ok: true, queued: true };
    },
    async interruptWorker(taskId, reason) {
      calls.push(['interrupt', taskId, reason]);
      return { ok: true };
    },
    inspectDeliveryReview(reviewId) {
      calls.push(['inspect-review', reviewId]);
      return { id: reviewId, taskId: reviewTaskId, status: 'active' };
    },
    async confirmDeliveryReviewEvidence(reviewId, input) {
      calls.push(['confirm-review-evidence', reviewId, input]);
      return { id: reviewId, taskId: reviewTaskId, status: 'active' };
    },
  };
  const slot = { id: 'session-a', orchestrator };
  const ctx = {
    registry: {
      get(id) { return id === 'session-a' ? slot : null; },
    },
  };
  const service = new TaskIpcService(ctx);
  return {
    service,
    events,
    listeners,
    calls,
    setRaceEvent(value) { raceEvent = value; },
    setDurableRecord(value, diagnostics = []) {
      durableRecord = value;
      projectionDiagnostics = diagnostics;
    },
    setReviewTaskId(value) { reviewTaskId = value; },
    emit(value) {
      events.push(value);
      for (const listener of listeners) listener(structuredClone(value));
    },
  };
}

function sender() {
  const messages = [];
  const destroyedListeners = [];
  return {
    id: 7,
    messages,
    isDestroyed() { return false; },
    send(channel, payload) { messages.push({ channel, payload }); },
    once(event, listener) {
      if (event === 'destroyed') destroyedListeners.push(listener);
      return this;
    },
    destroy() {
      for (const listener of destroyedListeners) listener();
    },
  };
}

test('task snapshot is bounded and hides authority internals', async () => {
  const { service } = createFixture();
  const result = await service.getSnapshot({ sessionId: 'session-a', taskId: 'task-a' });
  assert.equal(result.ok, true);
  assert.equal(result.value.task.id, 'task-a');
  assert.equal(result.value.task.backendId, 'codex');
  assert.equal(result.value.mailbox.length, 1);
  assert.equal(result.value.attempts[0].attempt, 1);
  assert.equal(result.value.lastSeq, 8);
  assert.deepEqual(result.value.task.authority, {
    allowedToolKinds: ['read', 'execute'],
    writePathCount: 1,
    commandCount: 1,
    networkHostCount: 1,
    hasEnvironmentAccess: true,
    expiresAt: 99_999,
  });
  const serialized = JSON.stringify(result.value);
  assert.doesNotMatch(serialized, /src\/secret|npm|internal\.example|SECRET_TOKEN|private\/worktree/);
  assert.match(serialized, /REDACTED/);
});

test('withheld review evidence is projected safely and confirmation is task-bound', async () => {
  const setup = createFixture();
  const chunkHash = 'f'.repeat(64);
  setup.emit(event(10, 'coordinator-review-requested', {
    session: {
      schemaVersion: 1,
      id: 'review-a',
      deliveryId: 'delivery-a',
      taskId: 'task-a',
      attempt: 1,
      status: 'active',
      chunkEvidence: [{
        id: 'chunk-a',
        hash: chunkHash,
        path: 'asset.bin',
        kind: 'binary',
        byteLength: 120,
        lineCount: 0,
        requiresUserConfirmation: true,
      }],
      confirmations: [],
    },
  }));

  const snapshot = await setup.service.getSnapshot({
    sessionId: 'session-a',
    taskId: 'task-a',
  });
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.value.reviewEvidence, {
    reviewId: 'review-a',
    status: 'active',
    pending: [{
      chunkId: 'chunk-a',
      chunkHash,
      path: 'asset.bin',
      kind: 'binary',
      byteLength: 120,
      lineCount: 0,
    }],
  });
  assert.doesNotMatch(JSON.stringify(snapshot.value), /raw|content/i);

  const confirmed = await setup.service.confirmReviewEvidence({
    sessionId: 'session-a',
    taskId: 'task-a',
    reviewId: 'review-a',
    chunkId: 'chunk-a',
    chunkHash,
  });
  assert.equal(confirmed.ok, true);
  assert.equal(setup.calls.some((call) => (
    call[0] === 'confirm-review-evidence'
    && call[1] === 'review-a'
    && call[2].chunkId === 'chunk-a'
    && call[2].chunkHash === chunkHash
    && /^user-/.test(call[2].decisionId)
  )), true);

  setup.setReviewTaskId('task-other');
  assert.deepEqual(
    await setup.service.confirmReviewEvidence({
      sessionId: 'session-a',
      taskId: 'task-a',
      reviewId: 'review-a',
      chunkId: 'chunk-a',
      chunkHash,
    }),
    { ok: false, error: 'Review does not belong to this task' },
  );
});

test('task snapshot uses durable attempt evidence when available', async () => {
  const setup = createFixture();
  setup.setDurableRecord({
    title: 'Durable task',
    prompt: 'Durable prompt',
    deps: ['dependency-a'],
    status: 'coordinator-reviewing',
    currentAttempt: 2,
    requestedProfile: { backendId: 'codex', workMode: 'balanced' },
    effectiveProfile: { backendId: 'codex', mode: 'balanced' },
    contextPackage: { mode: 'meeting-summary', messages: [], decisions: [], dependencyReports: [], attachments: [] },
    authorityGrant: { allowedToolKinds: ['read'], writePaths: [], allowedCommands: [] },
    workspace: { kind: 'git-worktree', branch: 'task-a', sourceRevision: 'abc123', managed: true },
    attempts: [
      {
        attempt: 1,
        backendId: 'codex',
        startedAt: 100,
        finishedAt: 200,
        durationMs: 100,
        tokenCost: 12,
        failureFingerprint: 'failure-a',
        report: { summary: 'Bearer durable-secret-value' },
      },
      {
        attempt: 2,
        backendId: 'claude-code',
        startedAt: 300,
        durationMs: 50,
        tokenCost: 5,
        verification: { status: 'passed' },
        reviewCoverage: { reviewedChunks: 2, totalChunks: 2 },
        candidateCommit: 'deadbeef',
      },
    ],
  }, [{
    code: 'stale-event',
    message: 'stale task event ignored',
  }]);

  const result = await setup.service.getSnapshot({
    sessionId: 'session-a',
    taskId: 'task-a',
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.task.title, 'Durable task');
  assert.equal(result.value.task.status, 'coordinator-reviewing');
  assert.equal(result.value.task.attempt, 2);
  assert.equal(result.value.attempts.length, 2);
  assert.equal(result.value.attempts[0].status, 'failed');
  assert.equal(result.value.attempts[1].candidateCommit, 'deadbeef');
  assert.deepEqual(result.value.diagnostics, [{
    code: 'stale-event',
    message: 'stale task event ignored',
  }]);
  assert.doesNotMatch(JSON.stringify(result.value), /durable-secret-value/);
});

test('task replay pages by Meeting cursor and preserves the task predecessor chain', async () => {
  const { service } = createFixture();
  const first = await service.getEvents({
    sessionId: 'session-a',
    taskId: 'task-a',
    afterSeq: 0,
    limit: 2,
  });
  assert.equal(first.ok, true);
  assert.deepEqual(first.value.events.map((entry) => [entry.seq, entry.previousSeq]), [
    [2, 0],
    [5, 2],
  ]);
  assert.equal(first.value.nextAfterSeq, 5);
  assert.equal(first.value.hasMore, true);

  const second = await service.getEvents({
    sessionId: 'session-a',
    taskId: 'task-a',
    afterSeq: first.value.nextAfterSeq,
    limit: 999,
  });
  assert.equal(second.ok, true);
  assert.deepEqual(second.value.events.map((entry) => [entry.seq, entry.previousSeq]), [[8, 5]]);
  assert.equal(second.value.hasMore, false);
});

test('task IPC never falls back to another session or task', async () => {
  const { service } = createFixture();
  assert.deepEqual(
    await service.getSnapshot({ sessionId: 'session-b', taskId: 'task-a' }),
    { ok: false, error: 'Session not found', code: 'not-found' },
  );
  assert.deepEqual(
    await service.getSnapshot({ sessionId: 'session-a', taskId: 'task-b' }),
    { ok: false, error: 'Task not found', code: 'not-found' },
  );
  assert.equal((await service.getEvents({
    sessionId: 'session-a',
    taskId: 'task-a',
    afterSeq: -1,
    limit: 10,
  })).ok, false);
  assert.equal((await service.getEvents({
    sessionId: 'session-a',
    taskId: 'task-a',
    afterSeq: 0,
    limit: 0,
  })).ok, false);
});

test('subscription buffers the replay race exactly once and unsubscribes', async () => {
  const setup = createFixture();
  const target = sender();
  const raced = event(10, 'task-message-enqueued', taskMessage(2, 'raced'));
  setup.setRaceEvent(raced);

  const result = await setup.service.subscribe(target, {
    sessionId: 'session-a',
    taskId: 'task-a',
    afterSeq: 8,
    subscriptionId: 'sub-a',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    target.messages.map((entry) => entry.payload.event.eventId),
    ['event-10'],
  );

  setup.emit(event(12, 'task-message-delivered', {
    messageId: 'message-2',
    messageSeq: 2,
  }));
  assert.deepEqual(
    target.messages.map((entry) => [
      entry.payload.event.seq,
      entry.payload.event.previousSeq,
    ]),
    [[10, 8], [12, 10]],
  );

  setup.service.unsubscribe(target, { subscriptionId: 'sub-a' });
  setup.emit(event(14, 'task-message-acknowledged', {
    messageId: 'message-2',
    messageSeq: 2,
  }));
  assert.equal(target.messages.length, 2);
});

test('subscription rejects an unbounded replay cursor and removes its listener', async () => {
  const setup = createFixture();
  const target = sender();
  for (let index = 0; index < 501; index += 1) {
    setup.events.push(event(20 + index, 'task-message-enqueued', taskMessage(20 + index)));
  }

  const result = await setup.service.subscribe(target, {
    sessionId: 'session-a',
    taskId: 'task-a',
    afterSeq: 0,
    subscriptionId: 'sub-too-old',
  });

  assert.deepEqual(result, {
    ok: false,
    error: 'Task subscription cursor is too old; fetch bounded event pages first',
    code: 'too-large',
  });
  assert.equal(target.messages.length, 0);
  assert.equal(setup.listeners.size, 0);
});

test('task action IPC stays task-scoped and bounded', async () => {
  const { service, calls } = createFixture();
  assert.equal((await service.followUp({
    sessionId: 'session-a',
    taskId: 'task-a',
    text: 'continue',
  })).ok, true);
  assert.deepEqual(await service.steer({
    sessionId: 'session-a',
    taskId: 'task-a',
    text: 'change direction',
  }), { ok: true, queued: true });
  assert.deepEqual(await service.interrupt({
    sessionId: 'session-a',
    taskId: 'task-a',
    reason: 'pause',
  }), { ok: true });
  assert.deepEqual(calls, [
    ['follow-up', 'task-a', 'continue'],
    ['steer', 'task-a', 'change direction'],
    ['interrupt', 'task-a', 'pause'],
  ]);
  assert.equal((await service.followUp({
    sessionId: 'session-a',
    taskId: 'task-a',
    text: 'x'.repeat(100_001),
  })).ok, false);
});

test('task event projection ignores other tasks and redacts durable payloads', () => {
  const projected = projectRendererTaskEvents([
    event(1, 'task-message-enqueued', taskMessage(1, 'api_key=supersecret')),
    event(2, 'task-message-enqueued', {
      ...taskMessage(1, 'other'),
      taskId: 'task-b',
    }, { taskId: 'task-b' }),
  ], 'task-a');
  assert.equal(projected.length, 1);
  assert.doesNotMatch(JSON.stringify(projected), /supersecret/);
});

test('task event projection ignores duplicate event IDs and task sequences', () => {
  const projected = projectRendererTaskEvents([
    event(1, 'task-message-enqueued', taskMessage(1, 'first')),
    event(1, 'task-message-enqueued', taskMessage(2, 'duplicate-sequence'), { id: 'event-other' }),
    event(3, 'task-message-enqueued', taskMessage(3, 'duplicate-id'), { id: 'event-1' }),
    event(4, 'task-message-enqueued', taskMessage(4, 'second')),
  ], 'task-a');

  assert.deepEqual(
    projected.map((entry) => [entry.eventId, entry.seq, entry.previousSeq]),
    [['event-1', 1, 0], ['event-4', 4, 1]],
  );
});
