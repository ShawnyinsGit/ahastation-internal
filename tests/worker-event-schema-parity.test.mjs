import assert from 'node:assert/strict';
import test from 'node:test';

import { workerEventSchema } from '../dist-electron/worker-protocol.js';
import { MEETING_TASK_STATUSES as mainMeetingTaskStatuses } from '../dist-electron/task-collaboration.js';
import { rendererWorkerEventSchema } from '../src/lib/worker-event-schema.ts';
import { MEETING_TASK_STATUSES as rendererMeetingTaskStatuses } from '../src/types.ts';

const base = {
  schemaVersion: 2,
  eventId: '769957cc-5d88-40a8-88a3-218d0cd63b49',
  seq: 1,
  timestamp: 1,
  meetingId: 'meeting',
  taskId: 'task',
  attempt: 1,
  workerId: 'worker',
  backendId: 'opencode',
  payload: { kind: 'progress', message: 'working', percent: 20 },
};

test('main and renderer WorkerEvent schemas stay in acceptance parity', () => {
  const cases = [
    base,
    { ...base, eventId: 'bad' },
    { ...base, payload: { kind: 'progress', message: '' } },
    { ...base, payload: { kind: 'tool', toolName: 'edit', phase: 'started' } },
    { ...base, payload: { kind: 'ended', reason: 'completed' } },
    { ...base, providerPayload: { raw: true } },
  ];
  for (const candidate of cases) {
    assert.equal(
      rendererWorkerEventSchema.safeParse(candidate).success,
      workerEventSchema.safeParse(candidate).success,
      JSON.stringify(candidate),
    );
  }
});

test('main and renderer MeetingTaskStatus values stay in parity', () => {
  assert.deepEqual(rendererMeetingTaskStatuses, mainMeetingTaskStatuses);
});
