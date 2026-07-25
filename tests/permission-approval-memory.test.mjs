import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compileTaskAuthority } from '../dist-electron/task-authority.js';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-approval-memory-'));
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
  return root;
}

function authorityRequest(overrides = {}) {
  return {
    writePaths: ['src/auth', 'tests'],
    toolKinds: ['read', 'write', 'command'],
    workingDirectories: ['.', 'tests'],
    commands: [['npm', 'test']],
    environmentKeys: ['CI', 'NODE_ENV'],
    maxCommandTimeoutMs: 120_000,
    networkHosts: [],
    ...overrides,
  };
}

/** Crafted high-risk command request: `OpaqueShell` carries only the
 *  memorizable opaque-shell effect; `DangerShell` adds destructive-git,
 *  which must never enter the fingerprint memory. */
function craftedCommand(nativeRequest, sideEffects) {
  return {
    ok: true,
    request: {
      schemaVersion: 1,
      taskId: nativeRequest.taskId,
      attempt: nativeRequest.attempt,
      backendId: 'codex',
      kind: 'command',
      workspaceRoot: nativeRequest.workspaceRoot,
      readPaths: [],
      writePaths: [],
      networkHosts: [],
      environmentKeys: [],
      sideEffects,
      cwd: nativeRequest.workspaceRoot,
      executable: 'sh',
      argv: ['-lc', 'scripted'],
      nativeRequestId: nativeRequest.nativeRequestId,
    },
  };
}

function makeScheduler({ root, taskIds }) {
  const backend = new CodexBackend();
  const emitted = [];
  const journal = [];
  const resolved = [];
  const autoApproveCalls = [];
  const session = {
    async start() {},
    sendUserText() {},
    sendUserContent() {},
    resolvePermission(id, decision, reason) {
      resolved.push({ id, decision, reason });
    },
    setAutoApproveScope(scope) { autoApproveCalls.push(scope); },
    async interrupt() {},
    end() {},
  };
  const scheduler = new WorkerScheduler({
    emit(event) { emitted.push(event); },
    cwd: root,
    autoApproveScope: 'off',
    taskAuthorityCompilerRequired: true,
    compileTaskAuthority(input) {
      return compileTaskAuthority(
        input.taskId,
        input.attempt,
        input.planVersion,
        input.approvalDecisionId,
        input.workspaceRoot,
        input.authorityRequest,
        input.approvedAt,
      );
    },
    async persistTaskAuthority() {},
    normalizePermissionRequest(_backendId, nativeRequest) {
      if (nativeRequest.toolName === 'OpaqueShell') {
        return craftedCommand(nativeRequest, ['opaque-shell']);
      }
      if (nativeRequest.toolName === 'DangerShell') {
        return craftedCommand(nativeRequest, ['opaque-shell', 'destructive-git']);
      }
      return backend.normalizePermissionRequest(nativeRequest);
    },
    async persistPermissionDecision(input) {
      journal.push({
        taskId: input.taskId,
        nativeRequestId: input.nativeRequestId,
        decision: input.decision,
        reason: input.reason,
      });
    },
    workspaceManager: {
      inspectBaseline() {
        return {
          kind: 'git-clean',
          revision: 'abc123',
          changedPaths: [],
          untrackedPaths: [],
          truncated: false,
        };
      },
      canPrepare() { return true; },
      prepare(taskId) {
        return {
          kind: 'git-worktree',
          cwd: root,
          branch: `task/${taskId}`,
          sourceRevision: 'abc123',
          lockKeys: [],
          baseline: {
            kind: 'git-clean',
            revision: 'abc123',
            changedPaths: [],
            untrackedPaths: [],
            truncated: false,
          },
          managed: true,
        };
      },
      release() {},
    },
    sessionFactory() { return session; },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
  });
  assert.deepEqual(scheduler.installPlan(taskIds.map((id) => ({
    id,
    title: `Task ${id}`,
    prompt: 'Do the work.',
    deps: [],
    executorBackendId: 'codex',
    writePaths: ['src/auth'],
    workspaceMode: 'git-worktree',
    authorityRequest: authorityRequest(),
  })), {
    decisionId: 'approval-memory',
    approvedAt: Date.now(),
  }), { ok: true });
  const tick = () => new Promise((resolvePromise) => setImmediate(resolvePromise));
  const ask = async (taskId, id, toolName, input) => {
    scheduler.onWorkerEvent(taskId, {
      kind: 'permission-request',
      id,
      toolName,
      input,
      toolUseID: id,
    });
    await tick();
  };
  const cards = () => emitted
    .map((entry) => entry.event)
    .filter((event) => event?.kind === 'permission-request');
  return { scheduler, emitted, journal, resolved, autoApproveCalls, tick, ask, cards };
}

test('an approved fingerprint auto-allows the byte-identical repeat', async () => {
  const root = workspace();
  const h = makeScheduler({ root, taskIds: ['mem-task'] });
  await h.tick();

  const opaque = { command: 'npm test && npm run build' };
  await h.ask('mem-task', 'opq-1', 'Bash', opaque);
  assert.equal(h.cards().length, 1);
  assert.equal(h.journal.at(-1).decision, 'ask-user');

  h.scheduler.resolvePermissionInAny('opq-1', 'allow');

  // Byte-identical repeat: no card, journalled + resolved as repeat-approved.
  await h.ask('mem-task', 'opq-2', 'Bash', opaque);
  assert.equal(h.cards().length, 1);
  assert.deepEqual(h.journal.at(-1), {
    taskId: 'mem-task',
    nativeRequestId: 'opq-2',
    decision: 'allow',
    reason: 'repeat-user-approved',
  });
  assert.deepEqual(
    h.resolved.find((entry) => entry.id === 'opq-2'),
    { id: 'opq-2', decision: 'allow', reason: 'repeat-user-approved' },
  );

  // A different opaque command is a different fingerprint: card again.
  await h.ask('mem-task', 'opq-3', 'Bash', { command: 'cat a | grep b' });
  assert.equal(h.cards().length, 2);
});

test('deny never seeds the fingerprint memory', async () => {
  const root = workspace();
  const h = makeScheduler({ root, taskIds: ['mem-task'] });
  await h.tick();

  const opaque = { command: 'npm test && npm run build' };
  await h.ask('mem-task', 'dny-1', 'Bash', opaque);
  assert.equal(h.cards().length, 1);
  h.scheduler.resolvePermissionInAny('dny-1', 'deny');

  await h.ask('mem-task', 'dny-2', 'Bash', opaque);
  assert.equal(h.cards().length, 2);
  assert.equal(h.journal.at(-1).decision, 'ask-user');
});

test('never-memorized side effects stay per-occurrence even after an allow', async () => {
  const root = workspace();
  const h = makeScheduler({ root, taskIds: ['mem-task'] });
  await h.tick();

  // Pure opaque-shell high-risk is memorizable.
  await h.ask('mem-task', 'hr-1', 'OpaqueShell', {});
  assert.equal(h.cards().length, 1);
  h.scheduler.resolvePermissionInAny('hr-1', 'allow');
  await h.ask('mem-task', 'hr-2', 'OpaqueShell', {});
  assert.equal(h.cards().length, 1);
  assert.equal(h.journal.at(-1).reason, 'repeat-user-approved');

  // destructive-git in the side effects excludes the request from memory.
  await h.ask('mem-task', 'dg-1', 'DangerShell', {});
  assert.equal(h.cards().length, 2);
  h.scheduler.resolvePermissionInAny('dg-1', 'allow');
  await h.ask('mem-task', 'dg-2', 'DangerShell', {});
  assert.equal(h.cards().length, 3);
  assert.equal(h.journal.at(-1).decision, 'ask-user');
});

test('a task-wide allow extends addendum and fingerprints to same-root peers', async () => {
  const root = workspace();
  const h = makeScheduler({ root, taskIds: ['mem-task', 'peer-task'] });
  await h.tick();

  // Fingerprint sharing: peer's identical request stops asking.
  await h.ask('mem-task', 'tw-1', 'OpaqueShell', {});
  assert.equal(h.cards().length, 1);
  h.scheduler.resolvePermissionInAny('tw-1', 'allow', undefined, 'task-wide');
  await h.ask('peer-task', 'tw-2', 'OpaqueShell', {});
  assert.equal(h.cards().length, 1);
  assert.deepEqual(h.journal.at(-1), {
    taskId: 'peer-task',
    nativeRequestId: 'tw-2',
    decision: 'allow',
    reason: 'repeat-user-approved',
  });

  // Addendum sharing: an authority-miss write approved task-wide covers the
  // same target for the peer via its own grant-bound addendum.
  await h.ask('mem-task', 'aw-1', 'Edit', { filePath: 'docs/readme.md' });
  assert.equal(h.cards().length, 2);
  assert.equal(h.journal.at(-1).reason, 'authority-miss:write-path-not-granted');
  h.scheduler.resolvePermissionInAny('aw-1', 'allow', undefined, 'task-wide');
  await h.ask('peer-task', 'aw-2', 'Edit', { filePath: 'docs/readme.md' });
  assert.equal(h.cards().length, 2);
  assert.deepEqual(h.journal.at(-1), {
    taskId: 'peer-task',
    nativeRequestId: 'aw-2',
    decision: 'allow',
    reason: 'within-user-approved-addendum',
  });
});

test('a worker-scoped allow does not leak to peers', async () => {
  const root = workspace();
  const h = makeScheduler({ root, taskIds: ['mem-task', 'peer-task'] });
  await h.tick();

  await h.ask('mem-task', 'ws-1', 'OpaqueShell', {});
  assert.equal(h.cards().length, 1);
  h.scheduler.resolvePermissionInAny('ws-1', 'allow');
  await h.ask('peer-task', 'ws-2', 'OpaqueShell', {});
  // Default scope stays per-worker: the peer still asks.
  assert.equal(h.cards().length, 2);
});

test('setAutoApproveScope never reaches grant-bound sessions', async () => {
  const root = workspace();
  const h = makeScheduler({ root, taskIds: ['mem-task'] });
  await h.tick();

  h.scheduler.setAutoApproveScope('all');
  assert.deepEqual(h.autoApproveCalls, []);
});
