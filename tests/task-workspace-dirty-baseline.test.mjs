import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DirtyWorkspaceWriteBlockedError,
  TaskWorkspaceManager,
} from '../dist-electron/task-workspace.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

async function gitFixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-dirty-git-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  await writeFile(join(cwd, 'tracked.txt'), 'base\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd });
  execFileSync('git', ['commit', '-m', 'base'], { cwd, stdio: 'ignore' });
  return cwd;
}

test('baseline inspection distinguishes changed and untracked paths without contents', async (t) => {
  const cwd = await gitFixture(t);
  await writeFile(join(cwd, 'tracked.txt'), 'secret changed contents\n');
  await writeFile(join(cwd, 'untracked.txt'), 'untracked secret contents\n');
  const manager = new TaskWorkspaceManager('meeting', cwd);

  const baseline = manager.inspectBaseline();

  assert.equal(baseline.kind, 'git-dirty');
  assert.match(baseline.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(baseline.changedPaths, ['tracked.txt']);
  assert.deepEqual(baseline.untrackedPaths, ['untracked.txt']);
  assert.equal(JSON.stringify(baseline).includes('secret changed contents'), false);
  assert.equal(JSON.stringify(baseline).includes('untracked secret contents'), false);
});

test('dirty git permits explicit read-only access to the selected workspace', async (t) => {
  const cwd = await gitFixture(t);
  await writeFile(join(cwd, 'dirty.txt'), 'visible user work\n');
  const manager = new TaskWorkspaceManager('meeting', cwd);

  const workspace = manager.prepare('reader', { mode: 'read-only', writePaths: [] });

  assert.equal(workspace.kind, 'read-only');
  assert.equal(workspace.cwd, cwd);
  assert.equal(workspace.managed, true);
  assert.equal(workspace.baseline.kind, 'git-dirty');
  assert.equal(workspace.diagnostic, 'dirty-base-visible-read-only');
  assert.deepEqual(workspace.lockKeys, []);
});

test('dirty git blocks isolated writers before filesystem or git mutation', async (t) => {
  const cwd = await gitFixture(t);
  await writeFile(join(cwd, 'dirty.txt'), 'user work\n');
  const worktreeRoot = join(cwd, '.test-worktrees');
  const manager = new TaskWorkspaceManager('meeting', cwd, { worktreeRoot });
  const beforeBranches = execFileSync('git', ['branch', '--format=%(refname)'], {
    cwd,
    encoding: 'utf8',
  });

  assert.equal(manager.canPrepare('writer', {
    mode: 'git-worktree',
    writePaths: ['tracked.txt'],
  }), false);
  assert.throws(
    () => manager.prepare('writer', {
      mode: 'git-worktree',
      writePaths: ['tracked.txt'],
    }),
    (error) => (
      error instanceof DirtyWorkspaceWriteBlockedError
      && error.code === 'dirty-workspace-write-blocked'
      && error.baseline.untrackedPaths.includes('dirty.txt')
    ),
  );
  assert.equal(existsSync(worktreeRoot), false);
  assert.equal(
    execFileSync('git', ['branch', '--format=%(refname)'], { cwd, encoding: 'utf8' }),
    beforeBranches,
  );
});

test('dirty git shared-locked mode is explicit unmanaged compatibility execution', async (t) => {
  const cwd = await gitFixture(t);
  await writeFile(join(cwd, 'dirty.txt'), 'user work\n');
  const manager = new TaskWorkspaceManager('meeting', cwd);

  const workspace = manager.prepare('compat-writer', {
    mode: 'shared-locked',
    writePaths: ['docs'],
  });

  assert.equal(workspace.kind, 'shared-locked');
  assert.equal(workspace.cwd, cwd);
  assert.equal(workspace.managed, false);
  assert.equal(workspace.diagnostic, 'shared-locked-compatibility-only');
  assert.equal(workspace.baseline.kind, 'git-dirty');
  assert.equal(workspace.lockKeys.length, 1);
});

test('source revision is honored for clean worktrees and invalid revisions fail before mutation', async (t) => {
  const cwd = await gitFixture(t);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const worktreeRoot = join(cwd, '.test-worktrees');
  const manager = new TaskWorkspaceManager('meeting', cwd, { worktreeRoot });

  assert.throws(() => manager.prepare('bad-source', {
    mode: 'git-worktree',
    writePaths: ['tracked.txt'],
    sourceRevision: 'not-a-commit',
  }), /source revision/i);
  assert.equal(existsSync(worktreeRoot), false);

  const workspace = manager.prepare('good-source', {
    mode: 'git-worktree',
    writePaths: ['tracked.txt'],
    sourceRevision,
  });
  assert.equal(workspace.sourceRevision, sourceRevision);
  assert.equal((await readdir(worktreeRoot)).length, 1);
  manager.release('good-source', true);
});

test('scheduler leaves dirty isolated writer pending with a visible revision diagnostic', async (t) => {
  const cwd = await gitFixture(t);
  await writeFile(join(cwd, 'dirty.txt'), 'user work\n');
  const events = [];
  let sessionCount = 0;
  const scheduler = new WorkerScheduler({
    emit(event) { events.push(event); },
    cwd,
    autoApproveScope: 'off',
    workspaceManager: new TaskWorkspaceManager('meeting', cwd, {
      worktreeRoot: join(cwd, '.test-worktrees'),
    }),
    sessionFactory() {
      sessionCount += 1;
      throw new Error('blocked task must not construct a backend session');
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
  });

  assert.deepEqual(scheduler.installPlan([{
    id: 'dirty-writer',
    title: 'Dirty writer',
    prompt: 'Edit tracked.txt.',
    deps: [],
    writePaths: ['tracked.txt'],
    workspaceMode: 'git-worktree',
  }]), { ok: true });

  assert.equal(sessionCount, 0);
  const snapshot = scheduler.snapshot().find((task) => task.id === 'dirty-writer');
  assert.equal(snapshot.status, 'pending');
  assert.equal(snapshot.workspaceDiagnostic.code, 'dirty-workspace-write-blocked');
  assert.ok(snapshot.workspaceDiagnostic.actions.includes('revise-to-shared-locked'));
  const briefing = events
    .map((entry) => entry.event)
    .find((event) => event.kind === 'coordinator-briefing');
  assert.equal(briefing.briefing.kind, 'workspace-blocked');
  assert.match(briefing.briefing.summary, /uncommitted changes/i);
  assert.equal(existsSync(join(cwd, '.test-worktrees')), false);
});
