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
  const first = manager.prepare('a', ['output/report.md']);
  assert.equal(first.kind, 'shared-locked');
  assert.equal(manager.canPrepare('b', ['output/report.md']), false);
  assert.throws(() => manager.prepare('b', ['output/report.md']), /locked by a/);
  manager.release('a', false);
  assert.equal(manager.canPrepare('b', ['output/report.md']), true);
  assert.equal(manager.prepare('b', ['output/report.md']).kind, 'shared-locked');
});

test('non-git locks serialize overlapping parent and child paths', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  manager.prepare('parent-owner', ['output']);
  assert.equal(manager.canPrepare('child-writer', ['output/report.md']), false);
  assert.equal(manager.canPrepare('other-writer', ['assets/icon.png']), true);
  manager.release('parent-owner', false);
  assert.equal(manager.canPrepare('child-writer', ['output/report.md']), true);
});

test('whole-workspace locks block every narrower write scope', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  manager.prepare('unknown-writer');
  assert.equal(manager.canPrepare('declared-writer', ['output/report.md']), false);
});

test('non-git write paths cannot escape the workspace', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-nongit-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = new TaskWorkspaceManager('meeting', cwd);
  assert.throws(() => manager.prepare('a', ['../outside']), /escapes workspace/);
});

test('git tasks receive isolated worktrees without touching dirty files', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-git-'));
  const meetingId = `meeting-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(cwd, 'tracked.txt'), 'base\n'));
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'base'], { cwd, stdio: 'ignore' });
  await import('node:fs/promises').then(({ writeFile }) => writeFile(join(cwd, 'dirty.txt'), 'user work\n'));

  const manager = new TaskWorkspaceManager(meetingId, cwd);
  const workspace = manager.prepare('task-a');
  assert.equal(workspace.kind, 'git-worktree');
  assert.notEqual(workspace.cwd, cwd);
  assert.equal(workspace.branch.includes('task-a'), true);
  manager.release('task-a', true);
});
