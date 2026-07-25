import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyApprovalGesture,
  compareApprovalPriority,
  summarizeApprovalTarget,
} from '../dist-electron/approval-gesture.js';

test('safe tools are low-gesture', () => {
  assert.equal(classifyApprovalGesture('Read', { file_path: 'a.ts' }), 'low');
  assert.equal(classifyApprovalGesture('Grep', { pattern: 'x' }), 'low');
});

test('write/edit tools are mid-gesture', () => {
  assert.equal(classifyApprovalGesture('Write', { file_path: 'src/a.ts' }), 'mid');
  assert.equal(classifyApprovalGesture('Bash', { command: 'npm test' }), 'mid');
});

test('always-destructive and dangerous bash are high-gesture', () => {
  assert.equal(
    classifyApprovalGesture('mcp__embedded-browser__browser_evaluate', { expression: '1' }),
    'high',
  );
  assert.equal(classifyApprovalGesture('Bash', { command: 'rm -rf /tmp/x' }), 'high');
  assert.equal(classifyApprovalGesture('Bash', { command: 'sudo apt install x' }), 'high');
});

test('summarizeApprovalTarget prefers basename then command', () => {
  assert.equal(summarizeApprovalTarget('Write', { file_path: '/ws/src/styles.css' }), 'styles.css');
  assert.equal(summarizeApprovalTarget('Bash', { command: 'npm run build' }), 'npm run build');
  assert.equal(summarizeApprovalTarget('Mystery', {}), 'Mystery');
});

test('compareApprovalPriority ranks high > mid > low, then earlier first', () => {
  const high = { risk: 'high', arrivedAt: 20 };
  const mid = { risk: 'mid', arrivedAt: 10 };
  const low = { risk: 'low', arrivedAt: 5 };
  const midLater = { risk: 'mid', arrivedAt: 30 };
  assert.ok(compareApprovalPriority(high, mid) < 0);
  assert.ok(compareApprovalPriority(mid, low) < 0);
  assert.ok(compareApprovalPriority(mid, midLater) < 0);
  const sorted = [low, midLater, high, mid].sort(compareApprovalPriority);
  assert.deepEqual(sorted.map((x) => x.risk), ['high', 'mid', 'mid', 'low']);
});
