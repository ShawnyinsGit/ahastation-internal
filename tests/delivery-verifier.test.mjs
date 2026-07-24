import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CommandDeliveryVerifier } from '../dist-electron/delivery-verifier.js';

const report = {
  status: 'completed',
  summary: 'done',
  files: [],
  tests: [],
  unresolved: [],
};

test('verifier runs approved argv without a shell and preserves manual checks', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aha-verify-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const verifier = new CommandDeliveryVerifier();
  const result = await verifier.verify({
    deliveryId: 'd',
    attempt: 1,
    meetingId: 'm',
    goal: 'verify',
    workspace: cwd,
    sourceRevision: 'base',
    acceptanceCriteria: [
      { id: 'node', description: 'node exits zero', verification: { kind: 'command', argv: [process.execPath, '-e', 'console.log(\"ok\")'] } },
      { id: 'manual', description: 'human review', verification: { kind: 'manual' } },
    ],
  }, report);
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].status, 'passed');
  assert.equal(result.checks[1].status, 'manual-pending');
});

test('verifier rejects reported paths outside or through a symlink', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aha-verify-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const verifier = new CommandDeliveryVerifier();
  const order = {
    deliveryId: 'd', attempt: 1, meetingId: 'm', goal: 'verify',
    workspace: cwd, sourceRevision: 'base',
    acceptanceCriteria: [{ id: 'manual', description: 'review', verification: { kind: 'manual' } }],
  };
  const escaped = await verifier.verify(order, {
    ...report,
    files: [{ path: '../outside', action: 'modified' }],
  });
  assert.equal(escaped.passed, false);
  assert.match(escaped.error, /escapes workspace/);

  await writeFile(join(cwd, 'inside.txt'), 'ok');
  const inside = await verifier.verify(order, {
    ...report,
    files: [{ path: 'inside.txt', action: 'modified' }],
  });
  assert.equal(inside.passed, true);
});

test('verifier caps and redacts command output', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'aha-verify-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const verifier = new CommandDeliveryVerifier();
  const result = await verifier.verify({
    deliveryId: 'd', attempt: 1, meetingId: 'm', goal: 'verify',
    workspace: cwd, sourceRevision: 'base',
    acceptanceCriteria: [{
      id: 'secret',
      description: 'redact',
      verification: {
        kind: 'command',
        argv: [process.execPath, '-e', 'console.log(\"token=secret-value sk-abcdefghijklmnop\")'],
      },
    }],
  }, report);
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].output.includes('secret-value'), false);
  assert.equal(result.checks[0].output.includes('sk-abcdefghijklmnop'), false);
});
