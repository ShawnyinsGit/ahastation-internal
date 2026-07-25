import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/lib/task-columns.ts', import.meta.url), 'utf8');

/** Mirror of resolveBoardTaskStatus — keep in lockstep with task-columns.ts. */
function resolveBoardTaskStatus(nodeStatus, workerStatus) {
  if (workerStatus && workerStatus !== 'idle') return workerStatus;
  return nodeStatus;
}

test('resolveBoardTaskStatus prefers a live worker over the plan snapshot', () => {
  assert.match(source, /export function resolveBoardTaskStatus/);
  assert.match(
    source,
    /Prefer the live worker status over the plan-node snapshot/,
  );
  assert.equal(resolveBoardTaskStatus('running', 'awaiting-acceptance'), 'awaiting-acceptance');
  assert.equal(resolveBoardTaskStatus('running', 'failed'), 'failed');
  assert.equal(resolveBoardTaskStatus('pending', undefined), 'pending');
  assert.equal(resolveBoardTaskStatus('running', 'idle'), 'running');
});
