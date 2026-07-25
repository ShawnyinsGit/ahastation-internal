import assert from 'node:assert/strict';
import { mkdtempSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compileReworkTaskAuthority,
  compileTaskAuthority,
  evaluateTaskAuthority,
  extendAuthorityAddendum,
} from '../dist-electron/task-authority.js';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

const APPROVED_AT = 1_700_000_000_000;

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-authority-'));
  mkdirSync(join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  return root;
}

function authorityRequest(overrides = {}) {
  return {
    writePaths: ['src/auth', 'tests'],
    toolKinds: ['read', 'write', 'command', 'network', 'external'],
    workingDirectories: ['.', 'tests'],
    commands: [
      ['npm', 'test'],
      ['npm', 'test', '--', 'auth'],
    ],
    environmentKeys: ['CI', 'NODE_ENV'],
    maxCommandTimeoutMs: 120_000,
    networkHosts: ['docs.example.com'],
    ...overrides,
  };
}

function grant(root, overrides = {}) {
  return compileTaskAuthority(
    'task-login',
    1,
    3,
    'approval-42',
    root,
    authorityRequest(overrides),
    APPROVED_AT,
  );
}

function canonical(root, overrides = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task-login',
    attempt: 1,
    backendId: 'codex',
    kind: 'read',
    workspaceRoot: root,
    readPaths: ['src/auth/login.ts'],
    writePaths: [],
    networkHosts: [],
    environmentKeys: [],
    sideEffects: [],
    nativeRequestId: 'native-1',
    ...overrides,
  };
}

test('plan approval compiles a deterministic attempt-bound grant', () => {
  const root = workspace();
  const first = grant(root);
  const second = grant(root);
  assert.deepEqual(first, second);
  assert.equal(first.taskId, 'task-login');
  assert.equal(first.attempt, 1);
  assert.equal(first.planVersion, 3);
  assert.equal(first.approvalDecisionId, 'approval-42');
  assert.ok(first.allowedToolKinds.includes('command'));
  assert.match(first.authorityRequestHash, /^[a-f0-9]{64}$/);
  assert.match(first.workspaceIdentityHash, /^[a-f0-9]{64}$/);
  assert.match(first.grantHash, /^[a-f0-9]{64}$/);
});

test('in-grant source writes and exact test argv auto-allow', () => {
  const root = workspace();
  const authority = grant(root);
  assert.deepEqual(
    evaluateTaskAuthority(authority, canonical(root, {
      kind: 'write',
      readPaths: [],
      writePaths: ['src/auth/login.ts'],
      sideEffects: ['workspace-write'],
    }), APPROVED_AT + 1),
    { kind: 'allow', reason: 'within-task-authority' },
  );
  assert.deepEqual(
    evaluateTaskAuthority(authority, canonical(root, {
      kind: 'command',
      readPaths: [],
      cwd: root,
      executable: 'npm',
      argv: ['test', '--', 'auth'],
      environmentKeys: ['CI'],
      timeoutMs: 60_000,
      sideEffects: ['process'],
    }), APPROVED_AT + 1),
    { kind: 'allow', reason: 'within-task-authority' },
  );
});

test('realpath aliases of the same workspace still authorize', () => {
  // macOS tmpdir is often /var/folders/... while realpath is /private/var/...
  // Grants store the realpath; requests may still carry the lexical form.
  const lexical = workspace();
  const authority = grant(lexical);
  const forms = Array.from(new Set([lexical, realpathSync(lexical)]));
  for (const root of forms) {
    assert.deepEqual(
      evaluateTaskAuthority(authority, canonical(root, {
        kind: 'write',
        readPaths: [],
        writePaths: ['src/auth/login.ts'],
        sideEffects: ['workspace-write'],
      }), APPROVED_AT + 1),
      { kind: 'allow', reason: 'within-task-authority' },
      root,
    );
    assert.equal(
      evaluateTaskAuthority(authority, canonical(root, {
        kind: 'command',
        readPaths: [],
        cwd: root,
        executable: 'npm',
        argv: ['test', '--', 'auth'],
        environmentKeys: ['CI'],
        timeoutMs: 60_000,
        sideEffects: ['process'],
      }), APPROVED_AT + 1).kind,
      'allow',
      root,
    );
  }
});

test('a hand-approved miss stops asking for the same target this attempt', () => {
  const root = workspace();
  const authority = grant(root, {
    writePaths: ['.vibe-assets/tasks/login'],
    commands: [['npm', 'test']],
    toolKinds: ['read', 'write', 'command', 'network'],
    networkHosts: [],
  });
  const write = canonical(root, {
    kind: 'write',
    readPaths: [],
    writePaths: ['src/auth/login.ts'],
    sideEffects: ['workspace-write'],
  });
  assert.equal(
    evaluateTaskAuthority(authority, write, APPROVED_AT + 1).reason,
    'authority-miss:write-path-not-granted',
  );

  const addendum = extendAuthorityAddendum(authority, write);
  assert.deepEqual(
    evaluateTaskAuthority(authority, write, APPROVED_AT + 2, addendum),
    { kind: 'allow', reason: 'within-user-approved-addendum' },
  );
  // Same coverage rule as compiled grants: the approved file covers siblings.
  assert.equal(
    evaluateTaskAuthority(authority, canonical(root, {
      kind: 'write',
      readPaths: [],
      writePaths: ['src/auth/session.ts'],
      sideEffects: ['workspace-write'],
    }), APPROVED_AT + 2, addendum).kind,
    'allow',
  );
  // Untouched dimensions and unrelated directories keep asking.
  assert.equal(
    evaluateTaskAuthority(authority, canonical(root, {
      kind: 'write',
      readPaths: [],
      writePaths: ['tests/login.test.ts'],
      sideEffects: ['workspace-write'],
    }), APPROVED_AT + 2, addendum).reason,
    'authority-miss:write-path-not-granted',
  );
  assert.equal(
    evaluateTaskAuthority(authority, canonical(root, {
      kind: 'command',
      readPaths: [],
      cwd: root,
      executable: 'npm',
      argv: ['run', 'build'],
      sideEffects: ['process'],
    }), APPROVED_AT + 2, addendum).reason,
    'authority-miss:command-not-granted',
  );
});

test('an addendum never crosses attempts, grants, or tool kinds', () => {
  const root = workspace();
  const authority = grant(root, {
    writePaths: ['.vibe-assets/tasks/login'],
    commands: [['npm', 'test']],
    toolKinds: ['read', 'write', 'command'],
    networkHosts: [],
  });
  const command = canonical(root, {
    kind: 'command',
    readPaths: [],
    cwd: root,
    executable: 'npm',
    argv: ['run', 'build'],
    sideEffects: ['process'],
  });
  const addendum = extendAuthorityAddendum(authority, command);
  assert.equal(
    evaluateTaskAuthority(authority, command, APPROVED_AT + 2, addendum).reason,
    'within-user-approved-addendum',
  );

  const rework = compileTaskAuthority(
    'task-login',
    2,
    3,
    'approval-42',
    root,
    authorityRequest({
      writePaths: ['.vibe-assets/tasks/login'],
      commands: [['npm', 'test']],
      toolKinds: ['read', 'write', 'command'],
      networkHosts: [],
    }),
    APPROVED_AT,
  );
  const reworkCommand = { ...command, attempt: 2 };
  assert.equal(
    evaluateTaskAuthority(rework, reworkCommand, APPROVED_AT + 2, addendum).reason,
    'authority-miss:command-not-granted',
  );

  // A read-only task cannot be promoted: the tool kind is denied first.
  const readOnly = grant(root, {
    writePaths: [],
    commands: [],
    toolKinds: ['read'],
    networkHosts: [],
  });
  const write = canonical(root, {
    kind: 'write',
    readPaths: [],
    writePaths: ['src/auth/login.ts'],
    sideEffects: ['workspace-write'],
  });
  assert.deepEqual(
    evaluateTaskAuthority(
      readOnly,
      write,
      APPROVED_AT + 2,
      extendAuthorityAddendum(readOnly, write),
    ),
    { kind: 'deny', reason: 'tool-kind-not-granted' },
  );
});

test('command grants allow argv prefixes and file grants cover siblings', () => {
  const root = workspace();
  const authority = grant(root, {
    writePaths: ['src/auth/login.ts'],
    commands: [['npm', 'test']],
    toolKinds: ['read', 'write', 'command'],
    networkHosts: [],
  });
  assert.equal(
    evaluateTaskAuthority(authority, canonical(root, {
      kind: 'command',
      readPaths: [],
      cwd: root,
      executable: 'npm',
      argv: ['test', '--coverage'],
      sideEffects: ['process'],
    }), APPROVED_AT + 1).kind,
    'allow',
  );
  assert.equal(
    evaluateTaskAuthority(authority, canonical(root, {
      kind: 'write',
      readPaths: [],
      writePaths: ['src/auth/login.test.ts'],
      sideEffects: ['workspace-write'],
    }), APPROVED_AT + 1).kind,
    'allow',
  );
});

test('path, cwd, argv, environment, timeout, and host escapes deny or ask', () => {
  const root = workspace();
  const authority = grant(root);
  const denyCases = [
    canonical(root, {
      kind: 'write',
      readPaths: [],
      writePaths: [],
      sideEffects: ['workspace-write'],
    }),
    canonical(root, {
      kind: 'write',
      readPaths: [],
      writePaths: ['../outside.txt'],
      sideEffects: ['workspace-write'],
    }),
    canonical(root, {
      kind: 'command',
      readPaths: [],
      cwd: '..',
      executable: 'npm',
      argv: ['test'],
      sideEffects: ['process'],
    }),
    canonical(root, {
      kind: 'command',
      readPaths: [],
      cwd: root,
      executable: 'npm',
      argv: ['test'],
      environmentKeys: ['API_KEY'],
      sideEffects: ['process'],
    }),
    canonical(root, {
      kind: 'command',
      readPaths: [],
      cwd: root,
      executable: 'npm',
      argv: ['test'],
      timeoutMs: 121_000,
      sideEffects: ['process'],
    }),
    canonical(root, {
      kind: 'network',
      readPaths: [],
      networkHosts: [],
      sideEffects: ['network'],
    }),
  ];
  for (const request of denyCases) {
    assert.equal(evaluateTaskAuthority(authority, request, APPROVED_AT + 1).kind, 'deny');
  }

  const askCases = [
    canonical(root, {
      kind: 'command',
      readPaths: [],
      cwd: root,
      executable: 'npm',
      argv: ['run', 'build'],
      sideEffects: ['process'],
    }),
    canonical(root, {
      kind: 'network',
      readPaths: [],
      networkHosts: ['evil.example.com'],
      sideEffects: ['network'],
    }),
    canonical(root, {
      kind: 'write',
      readPaths: [],
      writePaths: ['docs/readme.md'],
      sideEffects: ['workspace-write'],
    }),
  ];
  for (const request of askCases) {
    const decision = evaluateTaskAuthority(authority, request, APPROVED_AT + 1);
    assert.equal(decision.kind, 'ask-user', JSON.stringify(request));
    assert.match(decision.reason, /^authority-miss:/);
  }
});

test('destructive and external effects always ask the user', () => {
  const root = workspace();
  const authority = grant(root);
  for (const sideEffect of [
    'delete-data',
    'destructive-git',
    'credential-access',
    'administrator',
    'system-install',
    'external-publish',
    'external-message',
    'opaque-shell',
  ]) {
    const decision = evaluateTaskAuthority(authority, canonical(root, {
      kind: 'external',
      readPaths: [],
      sideEffects: [sideEffect],
    }), APPROVED_AT + 1);
    assert.equal(decision.kind, 'ask-user', sideEffect);
  }
});

test('task text, context, tampering, expiry, and task mismatch cannot grant authority', () => {
  const root = workspace();
  const authority = grant(root);
  assert.equal(evaluateTaskAuthority(
    { ...authority, grantHash: 'a'.repeat(64) },
    canonical(root),
    APPROVED_AT + 1,
  ).kind, 'deny');
  assert.equal(evaluateTaskAuthority(
    authority,
    canonical(root, { taskId: 'other-task' }),
    APPROVED_AT + 1,
  ).kind, 'deny');
  assert.equal(evaluateTaskAuthority(
    authority,
    canonical(root, { attempt: 2 }),
    APPROVED_AT + 1,
  ).kind, 'deny');
  assert.equal(evaluateTaskAuthority(
    authority,
    canonical(root),
    authority.expiresAt + 1,
  ).kind, 'deny');
  assert.equal('prompt' in authority, false);
  assert.equal('contextPackage' in authority, false);
});

test('rework can rebind a narrower-or-equal request but cannot change it', () => {
  const root = workspace();
  const original = grant(root);
  const retry = compileReworkTaskAuthority(
    original,
    2,
    root,
    authorityRequest({
      writePaths: ['src/auth'],
      toolKinds: ['read', 'write'],
      workingDirectories: ['.'],
      commands: [['npm', 'test']],
      environmentKeys: ['CI'],
      maxCommandTimeoutMs: 60_000,
      networkHosts: [],
    }),
  );
  assert.equal(retry.attempt, 2);
  assert.equal(retry.planVersion, original.planVersion);
  assert.equal(retry.approvalDecisionId, original.approvalDecisionId);
  assert.equal(retry.approvedAt, original.approvedAt);
  assert.equal(retry.expiresAt, original.expiresAt);
  assert.throws(
    () => compileReworkTaskAuthority(
      original,
      2,
      root,
      authorityRequest({ writePaths: ['src/auth', 'tests', 'docs'] }),
    ),
    /new plan approval/,
  );
});

test('existing symbolic-link ancestors are rejected', (t) => {
  const root = workspace();
  const outside = mkdtempSync(join(tmpdir(), 'ahastation-authority-outside-'));
  try {
    symlinkSync(outside, join(root, 'linked'), 'junction');
  } catch (error) {
    t.skip(`junction creation unavailable: ${String(error)}`);
    return;
  }
  assert.throws(
    () => grant(root, { writePaths: ['linked/file.txt'] }),
    /symbolic link|junction/,
  );
});

test('replacing a workspace at the same path invalidates its identity binding', (t) => {
  const root = workspace();
  const authority = grant(root);
  const original = lstatSync(root);
  rmSync(root, { recursive: true, force: true });
  // Linux CI filesystems aggressively hand the freed inode straight back to
  // the next mkdir — which would make dev+inode identical and the identity
  // check under test unobservable. Churn allocations until the replacement
  // workspace provably occupies a different inode.
  const parent = join(root, '..');
  const churn = [];
  let replaced = null;
  for (let attempt = 0; attempt < 64 && !replaced; attempt += 1) {
    const filler = join(parent, `.inode-churn-${process.pid}-${attempt}`);
    mkdirSync(filler, { recursive: true });
    churn.push(filler);
    mkdirSync(root, { recursive: true });
    const stat = lstatSync(root);
    if (stat.dev !== original.dev || stat.ino !== original.ino) {
      replaced = stat;
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  }
  t.after(() => churn.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
  assert.ok(replaced, 'could not allocate the replacement workspace on a fresh inode');
  assert.deepEqual(
    evaluateTaskAuthority(authority, canonical(root), APPROVED_AT + 1),
    { kind: 'deny', reason: 'workspace-identity-mismatch' },
  );
});

test('secret-bearing commands cannot enter an authority grant', () => {
  const root = workspace();
  assert.throws(
    () => grant(root, {
      commands: [['curl', 'https://example.com/path?token=never-store-this']],
    }),
    /secret-bearing/,
  );
});

test('scheduler persists canonical allow before resolving the backend request', async () => {
  const root = workspace();
  const order = [];
  const resolved = [];
  const emitted = [];
  const backend = new CodexBackend();
  const session = {
    async start() {},
    sendUserText() {},
    sendUserContent() {},
    resolvePermission(id, decision) {
      order.push(`resolve:${decision}`);
      resolved.push({ id, decision });
    },
    async interrupt() {},
    end() {},
  };
  const scheduler = new WorkerScheduler({
    emit(event) { emitted.push(event); },
    cwd: root,
    autoApproveScope: 'all',
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
    async persistTaskAuthority() { order.push('grant-persist'); },
    normalizePermissionRequest(_backendId, nativeRequest) {
      return backend.normalizePermissionRequest(nativeRequest);
    },
    async persistPermissionDecision(input) {
      order.push(`decision-persist:${input.decision}`);
    },
    workspaceManager: {
      canPrepare() { return true; },
      prepare() {
        return {
          kind: 'git-worktree',
          cwd: root,
          branch: 'task/permission-task',
          sourceRevision: 'abc123',
          lockKeys: [],
        };
      },
      release() {},
    },
    sessionFactory(options) {
      assert.equal(options.autoApproveScope, 'off');
      assert.equal(options.confirmDestructive, undefined);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
  });
  scheduler.installPlan([{
    id: 'permission-task',
    title: 'Permission task',
    prompt: 'Edit one file.',
    deps: [],
    executorBackendId: 'codex',
    writePaths: ['src/auth'],
    workspaceMode: 'git-worktree',
    authorityRequest: authorityRequest({
      toolKinds: ['read', 'write', 'command'],
    }),
  }], {
    decisionId: 'approval-permission',
    approvedAt: Date.now(),
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  scheduler.onWorkerEvent('permission-task', {
    kind: 'permission-request',
    id: 'permission-write',
    toolName: 'Edit',
    input: { file_path: 'src/auth/login.ts' },
    toolUseID: 'permission-write',
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.deepEqual(order.slice(-2), ['decision-persist:allow', 'resolve:allow']);
  assert.deepEqual(resolved, [{ id: 'permission-write', decision: 'allow' }]);
  assert.equal(
    emitted.some((entry) => entry.event?.kind === 'permission-request'),
    false,
  );

  scheduler.onWorkerEvent('permission-task', {
    kind: 'permission-request',
    id: 'permission-secret',
    toolName: 'Bash',
    input: {
      executable: 'curl',
      argv: ['--token', 'never-store-this'],
    },
    toolUseID: 'permission-secret',
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(order.at(-1), 'decision-persist:ask-user');
  const approvalCard = emitted
    .map((entry) => entry.event)
    .find((event) => event?.kind === 'permission-request');
  assert.equal(approvalCard.id, 'permission-secret');
  assert.equal(approvalCard.input.normalizationDiagnostic, 'secret-bearing-argument');
  assert.doesNotMatch(JSON.stringify(approvalCard), /never-store-this/);
});

test('repeated identical authority denials fail the worker instead of burning budget', async () => {
  const root = workspace();
  const resolved = [];
  const session = {
    async start() {},
    sendUserText() {},
    sendUserContent() {},
    resolvePermission(id, decision, reason) {
      resolved.push({ id, decision, reason });
    },
    async interrupt() {},
    end() {},
  };
  const backend = new CodexBackend();
  const scheduler = new WorkerScheduler({
    emit() {},
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
      return backend.normalizePermissionRequest(nativeRequest);
    },
    async persistPermissionDecision() {},
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
      prepare() {
        return {
          kind: 'git-worktree',
          cwd: root,
          branch: 'task/deny-loop',
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

  assert.deepEqual(scheduler.installPlan([{
    id: 'deny-loop',
    title: 'Deny loop',
    prompt: 'Only edit auth files.',
    deps: [],
    executorBackendId: 'codex',
    writePaths: ['src/auth'],
    workspaceMode: 'git-worktree',
    authorityRequest: authorityRequest({
      toolKinds: ['read', 'write'],
      commands: [],
      networkHosts: [],
    }),
  }], {
    decisionId: 'approval-deny-loop',
    approvedAt: Date.now(),
  }), { ok: true });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  for (let index = 0; index < 3; index += 1) {
    scheduler.onWorkerEvent('deny-loop', {
      kind: 'permission-request',
      id: `bash-${index}`,
      toolName: 'Bash',
      input: {
        executable: 'npm',
        argv: ['test'],
      },
      toolUseID: `bash-${index}`,
    });
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }

  assert.equal(resolved.filter((entry) => entry.decision === 'deny').length, 3);
  const node = scheduler.snapshot().find((task) => task.id === 'deny-loop');
  assert.equal(node?.status, 'failed');
  assert.match(node?.summary ?? '', /repeated authority denial/);
});
