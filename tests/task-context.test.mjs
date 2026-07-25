import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compileContextPackage,
  hashVisibleContextValue,
  renderContextPackageForWorker,
  verifyContextPackageIntegrity,
} from '../dist-electron/task-context.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';
import { listAuthorizedAssetReferences } from '../dist-electron/attachments/assets.js';

const HASH = 'a'.repeat(64);
const SECOND_HASH = 'b'.repeat(64);

function source(overrides = {}) {
  return {
    messages: [
      { id: 'm2', role: 'assistant', text: 'Second visible message', timestamp: 2 },
      { id: 'm1', role: 'user', text: 'First visible message', timestamp: 1 },
    ],
    meetingSummary: 'The user requested a login fix.',
    decisions: [{ id: 'd1', summary: 'Keep the existing session format.' }],
    dependencyReports: [{ taskId: 'dep-1', reportHash: HASH, summary: 'Dependency accepted.' }],
    attachments: [{ id: 'diagram.png', name: 'diagram.png', contentHash: SECOND_HASH }],
    ...overrides,
  };
}

function selection(mode, overrides = {}) {
  return {
    mode,
    messageIds: [],
    decisionIds: [],
    dependencyTaskIds: [],
    attachmentIds: [],
    ...overrides,
  };
}

function compile(mode, overrides = {}) {
  return compileContextPackage({
    taskId: 'task-login',
    attempt: 1,
    selection: selection(mode, overrides.selection),
    source: source(overrides.source),
    limits: overrides.limits ?? { maxBytes: 100_000, maxEstimatedTokens: 25_000 },
  });
}

test('all context modes compile deterministic visible packages', () => {
  const minimal = compile('minimal');
  const summary = compile('meeting-summary');
  const selected = compile('selected-history', {
    selection: {
      messageIds: ['m2'],
      decisionIds: ['d1'],
      dependencyTaskIds: ['dep-1'],
      attachmentIds: ['diagram.png'],
    },
  });
  const full = compile('full-visible-history');

  assert.deepEqual(minimal.messages, []);
  assert.deepEqual(summary.messages.map((entry) => entry.id), ['meeting-summary']);
  assert.deepEqual(selected.messages.map((entry) => entry.id), ['m2']);
  assert.deepEqual(selected.decisions.map((entry) => entry.id), ['d1']);
  assert.deepEqual(selected.dependencyReports.map((entry) => entry.taskId), ['dep-1']);
  assert.deepEqual(selected.attachments.map((entry) => entry.id), ['diagram.png']);
  assert.deepEqual(full.messages.map((entry) => entry.id), ['m1', 'm2']);
  assert.equal(compile('full-visible-history').packageHash, full.packageHash);
});

test('missing or unauthorized references reject the whole package', () => {
  for (const badSelection of [
    { messageIds: ['foreign-message'] },
    { decisionIds: ['foreign-decision'] },
    { dependencyTaskIds: ['foreign-task'] },
    { attachmentIds: ['../secret'] },
  ]) {
    assert.throws(
      () => compile('selected-history', { selection: badSelection }),
      /unauthorized or missing id/,
    );
  }
});

test('attachment IDs are authorized before selected bytes are hashed', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'ahastation-context-'));
  try {
    const assets = path.join(root, '.vibe-assets');
    await fs.mkdir(assets);
    await fs.writeFile(path.join(assets, 'allowed.txt'), 'visible');
    await fs.writeFile(path.join(assets, 'other.txt'), 'not selected');
    const references = await listAuthorizedAssetReferences(root, ['allowed.txt']);
    assert.deepEqual(references.map((entry) => entry.id), ['allowed.txt']);
    assert.match(references[0].contentHash, /^[a-f0-9]{64}$/);
    await assert.rejects(
      listAuthorizedAssetReferences(root, ['../secret.txt']),
      /unauthorized or missing id/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('credentials and native metadata never enter the package', () => {
  const contextPackage = compile('full-visible-history', {
    source: {
      messages: [{
        id: 'm1',
        role: 'user',
        text: 'authorization: Bearer abcdefghijklmnop',
        timestamp: 1,
        nativePayload: { api_key: 'must-not-appear' },
      }],
      backendAuthentication: { access_token: 'must-not-appear' },
    },
  });
  const serialized = JSON.stringify(contextPackage);
  assert.doesNotMatch(serialized, /abcdefghijklmnop|must-not-appear|nativePayload|backendAuthentication/);
  assert.match(serialized, /REDACTED/);
});

test('byte and estimated-token limits fail closed', () => {
  assert.throws(
    () => compile('full-visible-history', { limits: { maxBytes: 10, maxEstimatedTokens: 10_000 } }),
    /byte limit/,
  );
  assert.throws(
    () => compile('full-visible-history', { limits: { maxBytes: 100_000, maxEstimatedTokens: 1 } }),
    /estimated token limit/,
  );
});

test('hashes change with visible content but not object key ordering', () => {
  assert.equal(
    hashVisibleContextValue({ alpha: 1, beta: { x: 2, y: 3 } }),
    hashVisibleContextValue({ beta: { y: 3, x: 2 }, alpha: 1 }),
  );
  assert.notEqual(
    compile('full-visible-history').packageHash,
    compile('full-visible-history', {
      source: {
        messages: [{ id: 'm1', role: 'user', text: 'Changed visible message', timestamp: 1 }],
      },
    }).packageHash,
  );
});

test('the initial package is deeply frozen and rendered without hidden context', () => {
  const contextPackage = compile('selected-history', {
    selection: { messageIds: ['m1'], decisionIds: ['d1'] },
  });
  assert.equal(Object.isFrozen(contextPackage), true);
  assert.equal(Object.isFrozen(contextPackage.messages), true);
  assert.equal(Object.isFrozen(contextPackage.messages[0]), true);
  assert.equal(verifyContextPackageIntegrity(contextPackage), true);
  assert.equal(verifyContextPackageIntegrity({
    ...contextPackage,
    messages: [{ ...contextPackage.messages[0], text: 'tampered' }],
  }), false);
  assert.throws(() => contextPackage.messages.push({ id: 'late', role: 'user', text: 'late' }));
  const firstMessage = renderContextPackageForWorker('Fix login.', contextPackage);
  assert.match(firstMessage, /Fix login/);
  assert.match(firstMessage, new RegExp(contextPackage.packageHash));
  assert.doesNotMatch(firstMessage, /Second visible message/);
});

function taskWithSelection(contextSelection) {
  return {
    id: 'task-login',
    title: 'Fix login',
    prompt: 'Fix login.',
    deps: [],
    executorBackendId: 'codex',
    executionProfile: {
      schemaVersion: 1,
      backendId: 'codex',
      workMode: 'balanced',
      contextMode: contextSelection.mode,
      timeoutMs: 1_800_000,
      maxTokenBudget: 200_000,
    },
    contextSelection,
    workspaceMode: 'read-only',
    authorityRequest: {
      writePaths: [],
      toolKinds: ['read'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
  };
}

test('failed context compilation creates no worktree and no Backend session', async () => {
  let prepared = 0;
  let sessions = 0;
  let persisted = 0;
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    workspaceManager: {
      canPrepare() { return true; },
      prepare() { prepared += 1; throw new Error('must not prepare'); },
      release() {},
    },
    sessionFactory() {
      sessions += 1;
      throw new Error('must not create session');
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    contextCompilerRequired: true,
    async getAuthorizedTaskContextSource() { return source({ messages: [] }); },
    async persistContextPackage() { persisted += 1; },
  });
  scheduler.installPlan([taskWithSelection(selection('selected-history', {
    messageIds: ['missing'],
  }))]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, 0);
  assert.equal(sessions, 0);
  assert.equal(persisted, 0);
  assert.match(scheduler.describeWorkers('task-login'), /status=failed/);
});

test('package persistence finishes before workspace and Backend side effects', async () => {
  const order = [];
  const session = {
    async start() {},
    sendUserText(text) { this.firstMessage = text; },
    sendUserContent() {},
    resolvePermission() {},
    async interrupt() {},
    end() {},
  };
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    workspaceManager: {
      canPrepare() { return true; },
      prepare() {
        order.push('workspace');
        return {
          kind: 'shared-locked',
          cwd: process.cwd(),
          sourceRevision: 'non-git',
          lockKeys: [],
        };
      },
      release() {},
    },
    sessionFactory() {
      order.push('session');
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    contextCompilerRequired: true,
    async getAuthorizedTaskContextSource() {
      order.push('source');
      return source();
    },
    async persistContextPackage() { order.push('persist'); },
  });
  scheduler.installPlan([taskWithSelection(selection('minimal'))]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order.slice(0, 4), ['source', 'persist', 'workspace', 'session']);
  assert.match(session.firstMessage, /Frozen visible context/);
});
