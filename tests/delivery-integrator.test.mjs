import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceDeliveryIntegrator } from '../dist-electron/delivery-integrator.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'aha-integrate-'));
  const worktree = `${base}-worktree`;
  t.after(async () => {
    try { git(base, ['worktree', 'remove', '--force', worktree]); } catch {}
    await rm(worktree, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  });
  git(base, ['init']);
  git(base, ['config', 'user.email', 'test@example.com']);
  git(base, ['config', 'user.name', 'Test']);
  await writeFile(join(base, 'file.txt'), 'base\n');
  git(base, ['add', 'file.txt']);
  git(base, ['commit', '-m', 'base']);
  const sourceRevision = git(base, ['rev-parse', 'HEAD']);
  git(base, ['worktree', 'add', '-b', 'task-branch', worktree, 'HEAD']);
  return { base, worktree, sourceRevision };
}

function view(f, id = 'delivery-1') {
  return {
    id,
    meetingId: 'meeting',
    status: 'integrating',
    spec: { version: 1, objective: 'change', acceptanceCriteria: [] },
    sourceRevision: f.sourceRevision,
    workspace: f.worktree,
    attempt: 1,
    updatedAt: Date.now(),
  };
}

const candidate = {
  id: 'candidate',
  attempt: 1,
  report: {
    status: 'completed',
    summary: 'done',
    files: [{ path: 'file.txt', action: 'modified' }],
    tests: [],
    unresolved: [],
  },
  verification: { passed: true, checks: [] },
  review: { passed: true, findings: [] },
};

test('legacy per-task integration cannot publish a reviewed task to the user base', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'file.txt'), 'changed\n');
  await assert.rejects(
    new WorkspaceDeliveryIntegrator(f.base).integrate(view(f), candidate),
    /legacy direct-base integration is disabled/,
  );
  assert.equal((await readFile(join(f.base, 'file.txt'), 'utf8')).trim(), 'base');
  assert.equal(git(f.base, ['rev-parse', 'HEAD']), f.sourceRevision);
});

test('legacy integration remains disabled when the user base moved', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'file.txt'), 'task\n');
  await writeFile(join(f.base, 'base-only.txt'), 'moved\n');
  git(f.base, ['add', 'base-only.txt']);
  git(f.base, ['commit', '-m', 'move base']);

  await assert.rejects(
    new WorkspaceDeliveryIntegrator(f.base).integrate(view(f, 'delivery-2'), candidate),
    /legacy direct-base integration is disabled/,
  );
  assert.equal(await readFile(join(f.worktree, 'file.txt'), 'utf8'), 'task\n');
});

test('legacy integration never stages unreported task worktree changes', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.worktree, 'file.txt'), 'reported\n');
  await writeFile(join(f.worktree, 'hidden.txt'), 'not in the report\n');

  await assert.rejects(
    new WorkspaceDeliveryIntegrator(f.base).integrate(view(f, 'delivery-3'), candidate),
    /legacy direct-base integration is disabled/,
  );
  assert.equal(await readFile(join(f.base, 'file.txt'), 'utf8'), 'base\n');
  assert.equal(await readFile(join(f.worktree, 'hidden.txt'), 'utf8'), 'not in the report\n');
});

test('shared workspace integration is a no-copy record', async () => {
  const integrator = new WorkspaceDeliveryIntegrator('/repo');
  const result = await integrator.integrate({
    id: 'd',
    meetingId: 'm',
    status: 'integrating',
    spec: { version: 1, objective: 'change', acceptanceCriteria: [] },
    sourceRevision: 'non-git',
    workspace: '/repo',
    attempt: 1,
    updatedAt: Date.now(),
  }, candidate);
  assert.deepEqual(result, {
    kind: 'shared-locked',
    sourceRevision: 'non-git',
    workspace: '/repo',
  });
});
