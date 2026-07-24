import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hydrateTaskProjection,
  reduceTaskEvent,
} from '../src/lib/task-event-reducer.ts';

function snapshot() {
  return {
    schemaVersion: 1,
    sessionId: 'session-a',
    meetingId: 'meeting-a',
    task: {
      id: 'task-a',
      title: 'Task A',
      prompt: 'work',
      deps: [],
      status: 'running',
      backendId: 'codex',
      attempt: 1,
    },
    mailbox: [],
    mailboxTruncated: false,
    attempts: [{ attempt: 1, backendId: 'codex', status: 'running' }],
    diagnostics: [],
    lastSeq: 5,
  };
}

function event(seq, previousSeq, type, data = {}, options = {}) {
  return {
    schemaVersion: 1,
    eventId: options.eventId ?? `event-${seq}`,
    seq,
    previousSeq,
    timestamp: seq,
    taskId: options.taskId ?? 'task-a',
    attempt: 1,
    type,
    data,
  };
}

test('renderer applies task events idempotently', () => {
  let state = hydrateTaskProjection(snapshot());
  const message = {
    schemaVersion: 1,
    id: 'message-1',
    seq: 1,
    taskId: 'task-a',
    attempt: 1,
    sender: 'coordinator',
    kind: 'follow-up',
    payload: { text: 'continue' },
    status: 'queued',
    timestamp: 10,
  };
  state = reduceTaskEvent(state, event(8, 5, 'task-message-enqueued', { message }));
  state = reduceTaskEvent(state, event(10, 8, 'task-message-delivered', {
    messageId: 'message-1',
    messageSeq: 1,
  }));
  const duplicate = reduceTaskEvent(state, event(10, 8, 'task-message-delivered', {
    messageId: 'message-1',
    messageSeq: 1,
  }));

  assert.equal(state.snapshot.mailbox[0].status, 'delivered');
  assert.equal(state.lastSeq, 10);
  assert.equal(state.activity.length, 2);
  assert.deepEqual(duplicate, state);
});

test('renderer requests snapshot refresh on a task predecessor gap', () => {
  const initial = hydrateTaskProjection(snapshot());
  const next = reduceTaskEvent(initial, event(12, 8, 'worker-event', { kind: 'progress' }));
  assert.equal(next.needsRefresh, true);
  assert.match(next.diagnostic, /expected predecessor 5, received 8/);
  assert.equal(next.lastSeq, 5);
});

test('renderer ignores another task and projects plan status safely', () => {
  const initial = hydrateTaskProjection(snapshot());
  assert.deepEqual(
    reduceTaskEvent(initial, event(8, 5, 'task-plan-state', {}, { taskId: 'task-b' })),
    initial,
  );
  const next = reduceTaskEvent(initial, event(8, 5, 'task-plan-state', {
    status: 'verifying',
    deps: ['task-zero'],
  }));
  assert.equal(next.snapshot.task.status, 'verifying');
  assert.deepEqual(next.snapshot.task.deps, ['task-zero']);
});
