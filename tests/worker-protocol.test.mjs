import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractWorkReportFrame,
  parseWorkReport,
  truncateToolOutput,
  TOOL_OUTPUT_MAX_CHARS,
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

test('tool signal accepts optional CLI fidelity fields and rejects oversized output', () => {
  const legacy = { kind: 'tool', toolName: 'Bash', phase: 'started', detail: 'npm test' };
  assert.equal(workerAdapterSignalSchema.safeParse(legacy).success, true);
  const rich = {
    kind: 'tool',
    toolName: 'Bash',
    phase: 'completed',
    detail: 'npm test',
    callId: 'cmd-1',
    output: 'ok\n',
    exitCode: 0,
    durationMs: 12,
  };
  assert.equal(workerAdapterSignalSchema.safeParse(rich).success, true);
  assert.equal(workerAdapterSignalSchema.safeParse({
    ...rich,
    output: 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + 1),
  }).success, false);
  assert.equal(workerAdapterSignalSchema.safeParse({
    ...rich,
    unknownField: true,
  }).success, false);
});

test('truncateToolOutput keeps head and tail under the protocol budget', () => {
  const short = 'hello';
  assert.equal(truncateToolOutput(short), short);
  const long = `${'A'.repeat(40_000)}${'B'.repeat(40_000)}`;
  const truncated = truncateToolOutput(long);
  assert.ok(truncated.length <= TOOL_OUTPUT_MAX_CHARS);
  assert.ok(truncated.startsWith('A'.repeat(100)));
  assert.ok(truncated.endsWith('B'.repeat(100)));
  assert.match(truncated, /chars omitted/);
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
