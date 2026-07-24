import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractWorkReportFrame,
  parseWorkReport,
  workerAdapterSignalSchema,
  workerEventSchema,
} from '../dist-electron/worker-protocol.js';

const report = {
  status: 'completed',
  summary: 'Implemented the requested change.',
  files: [{ path: 'src/a.ts', action: 'modified' }],
  tests: [{ command: 'npm test', status: 'passed', summary: '42 tests passed' }],
  unresolved: [],
};

test('WorkReport is strict and requires delivery evidence fields', () => {
  assert.equal(parseWorkReport(report).ok, true);
  assert.equal(parseWorkReport({ ...report, summary: '' }).ok, false);
  assert.equal(parseWorkReport({ ...report, providerPayload: {} }).ok, false);
  assert.equal(parseWorkReport({
    ...report,
    unresolved: [{ code: 'decision', message: 'User input required', blocking: true }],
  }).ok, true);
});

test('all five provider-neutral Worker signals parse', () => {
  const signals = [
    { kind: 'progress', message: 'Reading files', percent: 10 },
    { kind: 'tool', toolName: 'Read', phase: 'completed', detail: 'src/a.ts' },
    { kind: 'delivery', report },
    { kind: 'failed', code: 'auth', message: 'Login required', retryable: true },
    { kind: 'ended', reason: 'interrupted' },
  ];
  for (const signal of signals) {
    assert.equal(workerAdapterSignalSchema.safeParse(signal).success, true);
  }
});

test('WorkerEvent v2 requires a durable identity envelope', () => {
  const event = {
    schemaVersion: 2,
    eventId: '769957cc-5d88-40a8-88a3-218d0cd63b49',
    seq: 1,
    timestamp: 1,
    meetingId: 'meeting-1',
    taskId: 'task-1',
    attempt: 1,
    workerId: 'worker-1',
    backendId: 'opencode',
    payload: { kind: 'delivery', report },
  };
  assert.equal(workerEventSchema.safeParse(event).success, true);
  assert.equal(workerEventSchema.safeParse({ ...event, taskId: undefined }).success, false);
  assert.equal(workerEventSchema.safeParse({ ...event, schemaVersion: 1 }).success, false);
});

test('extractWorkReportFrame removes exactly one valid report from visible text', () => {
  const text = `Finished the task.\n\n\`\`\`work-report\n${JSON.stringify(report)}\n\`\`\``;
  const extracted = extractWorkReportFrame(text);
  assert.equal(extracted.visibleText, 'Finished the task.');
  assert.deepEqual(extracted.report, report);
  assert.equal(extracted.error, undefined);
});

test('extractWorkReportFrame fails closed for invalid or repeated frames', () => {
  const invalid = extractWorkReportFrame('```work-report\n{"status":"completed"}\n```');
  assert.equal(Boolean(invalid.error), true);
  const frame = `\`\`\`work-report\n${JSON.stringify(report)}\n\`\`\``;
  const repeated = extractWorkReportFrame(`${frame}\n${frame}`);
  assert.equal(repeated.error, 'multiple work-report frames');
  assert.equal(repeated.report, undefined);
});

test('ordinary markdown fences are untouched', () => {
  const text = '```json\n{"hello":"world"}\n```';
  assert.deepEqual(extractWorkReportFrame(text), { visibleText: text });
});
