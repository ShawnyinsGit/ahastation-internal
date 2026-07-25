import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceWorkerEvent } from '../src/lib/worker-event-reducer.ts';

function state() {
  return {
    eventSeq: 0,
    lastText: '',
    currentTool: null,
    currentToolInput: null,
    summary: '',
    status: 'running',
    workerEvents: [],
  };
}

function event(seq, payload) {
  return {
    schemaVersion: 2,
    eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
    seq,
    timestamp: 1000 + seq,
    meetingId: 'meeting',
    taskId: 'task',
    attempt: 1,
    workerId: 'worker',
    backendId: 'opencode',
    payload,
  };
}

test('renderer WorkerEvent reducer projects progress, tools and WorkReport without provider messages', () => {
  let projected = reduceWorkerEvent(state(), event(1, {
    kind: 'progress', message: 'working', percent: 40,
  }), 'worker');
  assert.equal(projected.lastText, 'working');
  projected = reduceWorkerEvent(projected, event(2, {
    kind: 'tool', toolName: 'write', phase: 'started', detail: 'src/a.ts',
  }), 'worker');
  assert.equal(projected.currentTool, 'write');
  projected = reduceWorkerEvent(projected, event(3, {
    kind: 'delivery',
    report: {
      status: 'completed',
      summary: 'done',
      files: [],
      tests: [],
      unresolved: [],
    },
  }), 'worker');
  assert.equal(projected.summary, 'done');
  assert.equal(projected.eventSeq, 3);
  assert.equal(projected.workerEvents.length, 3);
});

test('renderer WorkerEvent reducer ignores wrong-source and out-of-order events', () => {
  const first = reduceWorkerEvent(state(), event(2, {
    kind: 'progress', message: 'new',
  }), 'worker');
  assert.equal(reduceWorkerEvent(first, event(1, {
    kind: 'progress', message: 'old',
  }), 'worker'), first);
  assert.equal(reduceWorkerEvent(first, event(3, {
    kind: 'failed', code: 'x', message: 'wrong source', retryable: false,
  }), 'provider-raw'), first);
});

test('renderer WorkerEvent reducer maps failure and interruption terminal states', () => {
  const failed = reduceWorkerEvent(state(), event(1, {
    kind: 'failed', code: 'auth', message: 'login required', retryable: false,
  }), 'worker');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.summary, 'login required');
  const interrupted = reduceWorkerEvent(state(), event(1, {
    kind: 'ended', reason: 'interrupted',
  }), 'worker');
  assert.equal(interrupted.status, 'interrupted');
});

test('malformed IPC Worker events are rejected before projection', () => {
  const current = state();
  const valid = event(1, { kind: 'progress', message: 'working' });
  assert.equal(reduceWorkerEvent(current, { ...valid, eventId: 'not-a-uuid' }, 'worker'), current);
  assert.equal(reduceWorkerEvent(current, {
    ...valid,
    payload: { kind: 'progress', message: '', providerRaw: { secret: true } },
  }, 'worker'), current);
});
