import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeWorkerCapacity,
  dependencyGateSatisfied,
} from '../src/lib/worker-capacity.ts';

test('capacity active slots exclude parked delivery statuses', () => {
  const capacity = computeWorkerCapacity([
    { id: 'a', title: 'A', status: 'running', deps: [] },
    { id: 'b', title: 'B', status: 'awaiting-acceptance', deps: [] },
    { id: 'c', title: 'C', status: 'coordinator-reviewing', deps: [] },
    { id: 'd', title: 'D', status: 'pending', deps: [] },
    { id: 'e', title: 'E', status: 'pending', deps: ['b'] },
  ]);
  assert.equal(capacity.active, 1);
  assert.equal(capacity.waiting, 1, 'pending with unmet accepted-gate dep stays waiting');
  assert.equal(capacity.saturated, false);
});

test('reviewed dependency gate unblocks waiting dependents in the capacity banner', () => {
  assert.equal(dependencyGateSatisfied({
    status: 'awaiting-acceptance',
    dependencyGate: 'reviewed',
    dependencyRelease: 'reviewed',
  }), true);
  assert.equal(dependencyGateSatisfied({
    status: 'awaiting-acceptance',
    dependencyGate: 'accepted',
    dependencyRelease: 'reviewed',
  }), false);
  assert.equal(dependencyGateSatisfied({
    status: 'coordinator-reviewing',
    dependencyGate: 'reviewed',
    dependencyRelease: 'none',
  }), false);
  assert.equal(dependencyGateSatisfied({
    status: 'integration-conflict',
    dependencyGate: 'reviewed',
    dependencyRelease: 'none',
  }), false);
  // Fallback without projected release: mid-review must not unlock.
  assert.equal(dependencyGateSatisfied({
    status: 'coordinator-reviewing',
    dependencyGate: 'reviewed',
  }), false);

  const capacity = computeWorkerCapacity([
    {
      id: 'analysis',
      title: 'Analysis',
      status: 'awaiting-acceptance',
      deps: [],
      dependencyGate: 'reviewed',
      dependencyRelease: 'reviewed',
    },
    {
      id: 'follow-on',
      title: 'Follow on',
      status: 'pending',
      deps: ['analysis'],
    },
    { id: 'r1', title: 'R1', status: 'running', deps: [] },
    { id: 'r2', title: 'R2', status: 'running', deps: [] },
    { id: 'r3', title: 'R3', status: 'running', deps: [] },
    { id: 'r4', title: 'R4', status: 'running', deps: [] },
  ]);
  assert.equal(capacity.active, 4);
  assert.equal(capacity.waiting, 1);
  assert.equal(capacity.saturated, true);
});

test('a launching pending node consumes a slot and is excluded from waiting', () => {
  const capacity = computeWorkerCapacity([
    { id: 'a', title: 'A', status: 'running', deps: [] },
    { id: 'b', title: 'B', status: 'pending', deps: [], launching: true },
    { id: 'c', title: 'C', status: 'pending', deps: [] },
    { id: 'd', title: 'D', status: 'pending', deps: [] },
  ]);
  assert.equal(capacity.active, 2, 'running + launching count as active');
  assert.equal(capacity.waiting, 2, 'the launching node is not waiting');
  assert.equal(capacity.saturated, false);
});

test('a launching node pushes a near-full board over the saturation threshold', () => {
  const capacity = computeWorkerCapacity([
    { id: 'r1', title: 'R1', status: 'running', deps: [] },
    { id: 'r2', title: 'R2', status: 'running', deps: [] },
    { id: 'r3', title: 'R3', status: 'running', deps: [] },
    { id: 'launching', title: 'L', status: 'pending', deps: [], launching: true },
    { id: 'w', title: 'W', status: 'pending', deps: [] },
  ]);
  assert.equal(capacity.active, 4);
  assert.equal(capacity.waiting, 1);
  assert.equal(capacity.saturated, true);
});
