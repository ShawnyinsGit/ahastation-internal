import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

function createScheduler(cwd, overrides = {}) {
  const events = [];
  const sessions = [];
  const scheduler = new WorkerScheduler({
    emit(event) { events.push(event); },
    cwd,
    autoApproveScope: 'off',
    workspaceManager: new TaskWorkspaceManager('meeting', cwd),
    sessionFactory(opts) {
      const session = {
        opts,
        inputs: [],
        async start() {},
        sendUserText(text) { this.inputs.push(text); },
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
        end() {},
      };
      sessions.push(session);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    ...overrides,
  });
  return { scheduler, events, sessions };
}

function writerTask(id, writePaths, extras = {}) {
  return {
    id,
    title: id,
    prompt: `write ${id}`,
    deps: [],
    writePaths,
    workspaceMode: 'shared-locked',
    ...extras,
  };
}

test('installPlan rejects writePaths that escape the workspace', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { scheduler } = createScheduler(cwd);

  const result = scheduler.installPlan([writerTask('bad', ['../outside.txt'])]);
  assert.equal(result.ok, false);
  assert.match(result.error, /task bad: write path escapes workspace/);
  assert.equal(scheduler.snapshot().length, 0);
});

test('installPlan downgrades git-worktree to shared-locked on non-git baselines', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { scheduler, sessions } = createScheduler(cwd);

  assert.deepEqual(scheduler.installPlan([{
    id: 'writer',
    title: 'Writer',
    prompt: 'Write a note',
    deps: [],
    writePaths: ['notes/hello.txt'],
    workspaceMode: 'git-worktree',
  }]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  const node = scheduler.snapshot().find((task) => task.id === 'writer');
  assert.equal(node?.workspaceMode, 'shared-locked');
  assert.equal(node?.status, 'running');
  assert.equal(sessions.length, 1);
});

test('installPlan suffixes terminal task ids on reuse', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { scheduler } = createScheduler(cwd);

  assert.deepEqual(scheduler.installPlan([writerTask('base', ['base.md'])]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  const liveBase = scheduler.workers.get('base');
  assert.ok(liveBase);
  liveBase.status = 'accepted';
  liveBase.session = null;
  scheduler.opts.workspaceManager.release('base', false);

  assert.deepEqual(scheduler.installPlan([writerTask('base', ['base-again.md'])]), { ok: true });
  assert.ok(scheduler.snapshot().some((task) => task.id === 'base-2'));
  assert.ok(scheduler.snapshot().some((task) => task.id === 'base' && task.status === 'accepted'));
});

test('installPlan allows deps on accepted tasks from a prior plan', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { scheduler } = createScheduler(cwd);

  assert.deepEqual(scheduler.installPlan([writerTask('alpha', ['alpha.md'])]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  const alpha = scheduler.workers.get('alpha');
  assert.ok(alpha);
  alpha.status = 'accepted';
  alpha.session = null;
  scheduler.opts.workspaceManager.release('alpha', false);
  alpha.workspace = null;

  assert.deepEqual(scheduler.installPlan([
    writerTask('beta', ['beta.md'], { deps: ['alpha'] }),
  ]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  const beta = scheduler.snapshot().find((task) => task.id === 'beta');
  assert.deepEqual(beta?.deps, ['alpha']);
  assert.equal(beta?.status, 'running');
});

test('steer unknown task reports available task ids', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { scheduler } = createScheduler(cwd);
  assert.deepEqual(scheduler.installPlan([writerTask('alive', ['alive.md'])]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  const steered = await scheduler.steerTask('missing', 'nudge');
  assert.equal(steered.ok, false);
  assert.equal(steered.reason, 'unknown');
  assert.deepEqual(steered.availableTaskIds, ['alive']);

  await assert.rejects(
    () => scheduler.queueFollowUp('missing', 'later'),
    /unknown task: missing; available: alive/,
  );
});

test('escaping writePaths on a pending task fail that task without blocking siblings', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const base = new TaskWorkspaceManager('meeting', cwd);
  const workspaceManager = {
    inspectBaseline: () => base.inspectBaseline(),
    preparationBlock: () => null,
    canPrepare(taskId, input) {
      if (taskId === 'poison') {
        throw new Error('write path escapes workspace: /tmp/workspace-explore-report.md');
      }
      return base.canPrepare(taskId, input);
    },
    prepare(taskId, input) {
      return base.prepare(taskId, input);
    },
    release(taskId, removeWorktree) {
      return base.release(taskId, removeWorktree);
    },
  };

  const { scheduler, sessions } = createScheduler(cwd, { workspaceManager });
  assert.deepEqual(scheduler.installPlan([
    writerTask('poison', ['poison.md']),
    writerTask('good', ['good.md']),
  ]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));

  const poison = scheduler.snapshot().find((task) => task.id === 'poison');
  const good = scheduler.snapshot().find((task) => task.id === 'good');
  assert.equal(poison.status, 'failed');
  assert.match(poison.summary, /escapes workspace/);
  assert.equal(good.status, 'running');
  assert.equal(sessions.length, 1);
});

test('new plan install still succeeds after a readiness throw from a prior pending task', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  let poisonStillPresent = true;
  const base = new TaskWorkspaceManager('meeting', cwd);
  const workspaceManager = {
    inspectBaseline: () => base.inspectBaseline(),
    preparationBlock: () => null,
    canPrepare(taskId, input) {
      if (poisonStillPresent && taskId === 'poison') {
        throw new Error('write path escapes workspace: /tmp/workspace-explore-report.md');
      }
      return base.canPrepare(taskId, input);
    },
    prepare(taskId, input) {
      return base.prepare(taskId, input);
    },
    release(taskId, removeWorktree) {
      return base.release(taskId, removeWorktree);
    },
  };

  const { scheduler, sessions } = createScheduler(cwd, { workspaceManager });
  assert.deepEqual(scheduler.installPlan([writerTask('poison', ['poison.md'])]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().find((task) => task.id === 'poison')?.status, 'failed');
  poisonStillPresent = false;

  assert.deepEqual(scheduler.installPlan([writerTask('follow-up', ['follow-up.md'])]), { ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.snapshot().find((task) => task.id === 'follow-up')?.status, 'running');
  assert.equal(sessions.length, 1);
});

test('revisePlan can cancel a pending sibling after a readiness throw fails another task', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-poison-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const base = new TaskWorkspaceManager('meeting', cwd);
  const workspaceManager = {
    inspectBaseline: () => base.inspectBaseline(),
    preparationBlock: () => null,
    canPrepare(taskId, input) {
      if (taskId === 'poison') {
        throw new Error('write path escapes workspace: /tmp/workspace-explore-report.md');
      }
      return false; // keep 'keep' pending so cancel-pending-task applies
    },
    prepare() {
      throw new Error('prepare should not run while canPrepare is false');
    },
    release(taskId, removeWorktree) {
      return base.release(taskId, removeWorktree);
    },
  };
  const { scheduler } = createScheduler(cwd, { workspaceManager });
  assert.deepEqual(scheduler.installPlan([
    writerTask('poison', ['poison.md']),
    writerTask('keep', ['keep.md']),
  ]), { ok: true });

  const result = await scheduler.revisePlan(1, [
    { kind: 'cancel-pending-task', taskId: 'keep' },
  ]);
  assert.deepEqual(result, { ok: true, planVersion: 2 });
  assert.equal(scheduler.snapshot().some((task) => task.id === 'keep'), false);
  assert.equal(scheduler.snapshot().find((task) => task.id === 'poison')?.status, 'failed');
});
