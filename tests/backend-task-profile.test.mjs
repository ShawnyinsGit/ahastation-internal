import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BackendRegistry,
} from '../dist-electron/backends/registry.js';
import {
  backendRuntimeSchema,
} from '../dist-electron/backends/task-profile.js';
import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { KimiBackend } from '../dist-electron/backends/kimi-adapter.js';
import {
  OpenCodeBackend,
  openCodePromptModel,
} from '../dist-electron/backends/opencode-adapter.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

const runtime = (backendId, runtimeVersion = '1.2.3') => ({
  schemaVersion: 1,
  backendId,
  runtimeVersion,
});

const requested = (backendId, overrides = {}) => ({
  schemaVersion: 1,
  backendId,
  workMode: 'deep',
  contextMode: 'meeting-summary',
  timeoutMs: 1_800_000,
  maxTokenBudget: 200_000,
  ...overrides,
});

test('Codex deep compiles to the pinned native high reasoning effort', () => {
  const profile = new CodexBackend().compileTaskProfile(
    requested('codex', { modelPreference: 'gpt-5.4' }),
    runtime('codex', '0.144.1'),
  );

  assert.equal(profile.model, 'gpt-5.4');
  assert.deepEqual(profile.nativeReasoning, { modelReasoningEffort: 'high' });
  assert.deepEqual(profile.unsupported, []);
  assert.deepEqual(profile.downgraded, []);
});

test('Claude emits only pinned SDK effort and adaptive thinking settings', () => {
  const profile = new ClaudeCodeBackend().compileTaskProfile(
    requested('claude-code', { workMode: 'balanced' }),
    runtime('claude-code', '2.1.150'),
  );

  assert.deepEqual(profile.nativeReasoning, {
    effort: 'medium',
    thinking: { type: 'adaptive' },
  });
});

test('OpenCode compiles a provider/model prompt binding and reports reasoning downgrade', () => {
  const profile = new OpenCodeBackend().compileTaskProfile(
    requested('opencode', {
      modelPreference: 'openai/gpt-5.4',
      workMode: 'deep',
    }),
    runtime('opencode', '1.18.3'),
  );

  assert.equal(profile.model, 'openai/gpt-5.4');
  assert.deepEqual(profile.nativeReasoning, {
    promptModel: { providerID: 'openai', modelID: 'gpt-5.4' },
  });
  assert.deepEqual(profile.unsupported, ['workMode']);
  assert.deepEqual(profile.downgraded, ['workMode:deep->backend-default']);
  assert.deepEqual(openCodePromptModel({
    cwd: '/workspace',
    model: profile.model,
    taskProfile: profile,
  }), {
    providerID: 'openai',
    modelID: 'gpt-5.4',
  });
});

test('Kimi never claims an unsupported reasoning control', () => {
  const profile = new KimiBackend().compileTaskProfile(
    requested('kimi', { modelPreference: 'other-model', workMode: 'fast' }),
    runtime('kimi', '0.24.1'),
  );

  assert.equal(profile.model, 'kimi-latest');
  assert.equal(profile.nativeReasoning, undefined);
  assert.deepEqual(profile.unsupported, ['modelPreference', 'workMode']);
  assert.deepEqual(profile.downgraded, [
    'modelPreference:other-model->kimi-latest',
    'workMode:fast->backend-default',
  ]);
});

test('compilation is pure, stable, secret-free, and preserves requested intent', () => {
  const backend = new CodexBackend();
  const input = requested('codex', { modelPreference: 'gpt-5.4' });
  const first = backend.compileTaskProfile(input, runtime('codex', '0.144.1'));
  const second = backend.compileTaskProfile(
    structuredClone(input),
    runtime('codex', '0.144.1'),
  );

  assert.deepEqual(input, requested('codex', { modelPreference: 'gpt-5.4' }));
  assert.equal(first.capabilityHash, second.capabilityHash);
  assert.match(first.capabilityHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /api[_-]?key|authorization|credential/i);
  assert.notStrictEqual(first, input);
});

test('missing or mismatched runtime version fails closed', () => {
  assert.equal(backendRuntimeSchema.safeParse({
    schemaVersion: 1,
    backendId: 'codex',
    runtimeVersion: '',
  }).success, false);
  assert.throws(
    () => new CodexBackend().compileTaskProfile(
      requested('codex'),
      runtime('claude-code', '2.1.150'),
    ),
    /runtime backend mismatch/i,
  );
});

test('registry rejects worker backends without a compiler', () => {
  const registry = new BackendRegistry();
  registry.register({
    id: 'missing-compiler',
    capabilities: {
      coordinate: false,
      executeTasks: true,
      displayName: 'Missing compiler',
      iconId: 'missing',
      mcp: false,
      permissions: false,
      systemPrompt: false,
      skills: false,
      interrupt: true,
    },
    createSession() { throw new Error('not used'); },
    resolveBinary() { return '/fake'; },
    buildEnv() { return {}; },
  });

  assert.throws(
    () => registry.compileTaskProfile(
      'missing-compiler',
      requested('missing-compiler'),
      runtime('missing-compiler'),
    ),
    /does not compile task profiles/i,
  );
});

function schedulerTask() {
  return {
    id: 'profile-task',
    title: 'Profile task',
    prompt: 'Do the task.',
    deps: [],
    executorBackendId: 'codex',
    writePaths: ['src'],
    executionProfile: requested('codex'),
    contextSelection: {
      mode: 'meeting-summary',
      messageIds: [],
      dependencyTaskIds: [],
      attachmentIds: [],
    },
    workspaceMode: 'git-worktree',
    authorityRequest: {
      writePaths: ['src'],
      toolKinds: ['read', 'write', 'execute'],
      workingDirectories: ['.'],
      commands: [['npm', 'test']],
      environmentKeys: [],
      maxCommandTimeoutMs: 1_800_000,
      networkHosts: [],
    },
  };
}

function contextSource() {
  return {
    messages: [],
    meetingSummary: 'Visible meeting summary.',
    decisions: [],
    dependencyReports: [],
    attachments: [],
  };
}

test('scheduler persists effective profile before workspace and session', async () => {
  const order = [];
  let receivedOptions;
  const session = {
    async start() {},
    sendUserText() {},
    sendUserContent() {},
    resolvePermission() {},
    async interrupt() {},
    end() {},
  };
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    contextCompilerRequired: true,
    taskProfileCompilerRequired: true,
    async getAuthorizedTaskContextSource() {
      order.push('context-source');
      return contextSource();
    },
    async persistContextPackage() { order.push('context-persist'); },
    async compileTaskProfile(profile) {
      order.push('profile-compile');
      return {
        runtime: runtime(profile.backendId, '0.144.1'),
        effectiveProfile: new CodexBackend().compileTaskProfile(
          profile,
          runtime(profile.backendId, '0.144.1'),
        ),
      };
    },
    async persistTaskProfile() { order.push('profile-persist'); },
    workspaceManager: {
      canPrepare() { return true; },
      prepare() {
        order.push('workspace');
        return {
          kind: 'git-worktree',
          cwd: process.cwd(),
          branch: 'task/profile-task',
          sourceRevision: 'abc123',
          lockKeys: [],
        };
      },
      release() {},
    },
    sessionFactory(options) {
      order.push('session');
      receivedOptions = options;
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
  });

  scheduler.installPlan([schedulerTask()]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order.slice(0, 6), [
    'context-source',
    'context-persist',
    'profile-compile',
    'profile-persist',
    'workspace',
    'session',
  ]);
  assert.equal(receivedOptions.sessionOptions.model, 'gpt-5.4');
  assert.equal(
    receivedOptions.sessionOptions.taskProfile.nativeReasoning.modelReasoningEffort,
    'high',
  );
});

test('profile compilation failure produces no workspace or session side effect', async () => {
  let prepared = 0;
  let sessions = 0;
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: process.cwd(),
    autoApproveScope: 'off',
    contextCompilerRequired: true,
    taskProfileCompilerRequired: true,
    async getAuthorizedTaskContextSource() { return contextSource(); },
    async persistContextPackage() {},
    async compileTaskProfile() { throw new Error('runtime version unavailable'); },
    async persistTaskProfile() { throw new Error('must not persist'); },
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
  });

  scheduler.installPlan([schedulerTask()]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(prepared, 0);
  assert.equal(sessions, 0);
  const snapshot = scheduler.snapshot().find((task) => task.id === 'profile-task');
  assert.equal(snapshot.status, 'interrupted');
  assert.match(snapshot.summary, /runtime version unavailable/);
});
