import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';

function fakeSessionFactory(opts) {
  return {
    opts,
    async start() {},
    end() {},
    sendUserText() {},
    sendUserContent() {},
    resolvePermission() {},
    async interrupt() {},
  };
}

test('Coordinator applies a versioned running-plan revision and journals it', async () => {
  const meetingId = `plan-revision-${randomUUID()}`;
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: '/tmp',
    meetingId,
    sessionFactory: fakeSessionFactory,
  });
  try {
    assert.deepEqual(await orchestrator.installPlan([
      { id: 'active', title: 'Active', prompt: 'work', deps: [] },
      { id: 'obsolete', title: 'Obsolete', prompt: 'wait', deps: ['active'] },
    ]), { ok: true });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await orchestrator.executeMeetingCommand('default', {
      kind: 'revise-plan',
      expectedPlanVersion: 1,
      reason: 'replace the pending follow-up',
      operations: [
        { kind: 'cancel-pending-task', taskId: 'obsolete' },
        {
          kind: 'add-task',
          task: {
            id: 'replacement',
            title: 'Replacement',
            prompt: 'run after active',
            deps: ['active'],
          },
        },
      ],
    }), { ok: true, value: { planVersion: 2 } });

    const stale = await orchestrator.executeMeetingCommand('default', {
      kind: 'revise-plan',
      expectedPlanVersion: 1,
      reason: 'stale retry',
      operations: [{
        kind: 'add-task',
        task: { id: 'must-not-land', title: 'Stale', prompt: 'do not run', deps: [] },
      }],
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /stale plan version/);

    const journal = await MeetingRepository.replay(meetingId);
    const revisions = journal.filter((entry) => entry.type === 'plan-revised-by-coordinator');
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].payload.planVersion, 2);
  } finally {
    await orchestrator.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});
