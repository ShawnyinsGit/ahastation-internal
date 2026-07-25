import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';

test('non-git tasks enforce declared write-path locks', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  const first = manager.prepare('a', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  });
  assert.equal(first.kind, 'shared-locked');
  assert.equal(first.managed, false);
  assert.equal(manager.canPrepare('b', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  }), false);
  assert.throws(() => manager.prepare('b', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  }), /locked by a/);
  manager.release('a', false);
  assert.equal(manager.canPrepare('b', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  }), true);
  assert.equal(manager.prepare('b', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  }).kind, 'shared-locked');
});

test('non-git locks serialize overlapping parent and child paths', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  manager.prepare('parent-owner', { mode: 'shared-locked', writePaths: ['output'] });
  assert.equal(manager.canPrepare('child-writer', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  }), false);
  assert.equal(manager.canPrepare('other-writer', {
    mode: 'shared-locked',
    writePaths: ['assets/icon.png'],
  }), true);
  manager.release('parent-owner', false);
  assert.equal(manager.canPrepare('child-writer', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  }), true);
});

test('whole-workspace locks block every narrower write scope', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  manager.prepare('unknown-writer', { mode: 'shared-locked', writePaths: [] });
  assert.equal(manager.canPrepare('declared-writer', {
    mode: 'shared-locked',
    writePaths: ['output/report.md'],
  }), false);
});

test('non-git write paths cannot escape the workspace', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  assert.throws(() => manager.prepare('a', {
    mode: 'shared-locked',
    writePaths: ['../outside'],
  }), /escapes workspace/);
});

test('canPrepare returns false for escaping write paths instead of throwing', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  assert.equal(manager.canPrepare('escape', {
    mode: 'shared-locked',
    writePaths: ['../outside'],
  }), false);
  assert.match(manager.validateWritePaths(['../outside']), /escapes workspace/);
  assert.equal(manager.validateWritePaths(['output/report.md']), null);
});

test('clean git tasks receive isolated worktrees', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-git-'));
  const meetingId = `meeting-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(cwd, 'tracked.txt'), 'base\n'));
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'base'], { cwd, stdio: 'ignore' });

  const manager = new TaskWorkspaceManager(meetingId, cwd);
  const workspace = manager.prepare('task-a', {
    mode: 'git-worktree',
    writePaths: ['tracked.txt'],
  });
  assert.equal(workspace.kind, 'git-worktree');
  assert.equal(workspace.managed, true);
  assert.equal(workspace.baseline.kind, 'git-clean');
  assert.notEqual(workspace.cwd, cwd);
  assert.equal(workspace.branch.includes('task-a'), true);
  assert.match(workspace.sourceRevision, /^[0-9a-f]{40}$/);
  manager.release('task-a', true);
});
