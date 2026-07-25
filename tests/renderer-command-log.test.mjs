import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMAND_LOG_CAP,
  reduceWorkerEvent,
  upsertCommandLog,
} from '../src/lib/worker-event-reducer.ts';

function state(overrides = {}) {
  return {
    eventSeq: 0,
    lastText: '',
    currentTool: null,
    currentToolInput: null,
    summary: '',
    status: 'running',
    workerEvents: [],
    commandLog: [],
    ...overrides,
  };
}

function event(seq, payload, extras = {}) {
  return {
    schemaVersion: 2,
    eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`,
    seq,
    timestamp: 1_000 + seq * 10,
    meetingId: 'meeting',
    taskId: 'task',
    attempt: 1,
    workerId: 'worker',
    backendId: 'codex',
    payload,
    ...extras,
  };
}

test('commandLog pairs started and completed by callId without cross-talk', () => {
  let projected = reduceWorkerEvent(state(), event(1, {
    kind: 'tool', toolName: 'Bash', phase: 'started', detail: 'npm test', callId: 'a',
  }), 'worker');
  projected = reduceWorkerEvent(projected, event(2, {
    kind: 'tool', toolName: 'Bash', phase: 'started', detail: 'ls', callId: 'b',
  }), 'worker');
  projected = reduceWorkerEvent(projected, event(3, {
    kind: 'tool',
    toolName: 'Bash',
    phase: 'completed',
    callId: 'b',
    output: 'readme.md\n',
    exitCode: 0,
  }), 'worker');
  projected = reduceWorkerEvent(projected, event(4, {
    kind: 'tool',
    toolName: 'Bash',
    phase: 'failed',
    callId: 'a',
    output: '1 failing',
    exitCode: 1,
  }), 'worker');

  assert.equal(projected.commandLog.length, 2);
  const a = projected.commandLog.find((entry) => entry.id === 'a');
  const b = projected.commandLog.find((entry) => entry.id === 'b');
  assert.equal(a.command, 'npm test');
  assert.equal(a.status, 'failed');
  assert.equal(a.exitCode, 1);
  assert.equal(a.output, '1 failing');
  assert.equal(b.command, 'ls');
  assert.equal(b.status, 'completed');
  assert.equal(b.output, 'readme.md\n');
  assert.equal(b.exitCode, 0);
});

test('commandLog accepts completed-before-started and ignores non-Bash tools', () => {
  let projected = reduceWorkerEvent(state(), event(1, {
    kind: 'tool',
    toolName: 'Bash',
    phase: 'completed',
    callId: 'late',
    detail: 'echo hi',
    output: 'hi\n',
    exitCode: 0,
  }), 'worker');
  projected = reduceWorkerEvent(projected, event(2, {
    kind: 'tool', toolName: 'Write', phase: 'completed', detail: 'a.ts', callId: 'w1',
  }), 'worker');
  assert.equal(projected.commandLog.length, 1);
  assert.equal(projected.commandLog[0].id, 'late');
  assert.equal(projected.commandLog[0].command, 'echo hi');
  assert.equal(projected.commandLog[0].status, 'completed');
});

test('commandLog caps at COMMAND_LOG_CAP by dropping oldest entries', () => {
  let log = [];
  for (let i = 0; i < COMMAND_LOG_CAP + 5; i += 1) {
    log = upsertCommandLog(log, {
      callId: `c-${i}`,
      command: `echo ${i}`,
      phase: 'started',
      timestamp: i,
    });
  }
  assert.equal(log.length, COMMAND_LOG_CAP);
  assert.equal(log[0].id, 'c-5');
  assert.equal(log.at(-1).id, `c-${COMMAND_LOG_CAP + 4}`);
});

test('out-of-order WorkerEvents do not corrupt an existing commandLog entry', () => {
  const first = reduceWorkerEvent(state(), event(2, {
    kind: 'tool',
    toolName: 'Bash',
    phase: 'completed',
    callId: 'x',
    detail: 'pwd',
    output: '/tmp\n',
    exitCode: 0,
  }), 'worker');
  const second = reduceWorkerEvent(first, event(1, {
    kind: 'tool',
    toolName: 'Bash',
    phase: 'started',
    callId: 'x',
    detail: 'pwd',
  }), 'worker');
  assert.equal(second, first);
  assert.equal(first.commandLog[0].status, 'completed');
});
