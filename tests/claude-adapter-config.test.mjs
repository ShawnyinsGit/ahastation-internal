import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';

test('Claude adapter carries the universal session configuration into the official SDK', async () => {
  let queryInput;
  let finish;
  let emittedInit = false;
  const fakeQuery = {
    initializationResult: async () => ({ session_id: 'claude-session-1' }),
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (!emittedInit) {
        emittedInit = true;
        return Promise.resolve({ value: {
          type: 'system', subtype: 'init', session_id: 'claude-session-1',
        }, done: false });
      }
      return new Promise((resolve) => { finish = resolve; });
    },
    async interrupt() { finish?.({ value: undefined, done: true }); },
    async setPermissionMode() {},
  };
  const backend = new ClaudeCodeBackend({
    queryFactory: (input) => { queryInput = input; return fakeQuery; },
  });
  const taskProfile = backend.compileTaskProfile({
    schemaVersion: 1,
    backendId: 'claude-code',
    modelPreference: 'claude-test-model',
    workMode: 'deep',
    contextMode: 'meeting-summary',
    timeoutMs: 1_800_000,
    maxTokenBudget: 200_000,
  }, {
    schemaVersion: 1,
    backendId: 'claude-code',
    runtimeVersion: '2.1.150',
  });
  const session = backend.createSession({
    cwd: '/workspace',
    systemPrompt: 'meeting host',
    model: 'claude-test-model',
    mcpServers: { meeting: { type: 'sdk' } },
    skills: ['review'],
    extra: { settingSources: [], tools: [] },
    resumeSessionId: 'claude-session-old',
    taskProfile,
  }, () => {});

  await session.start();
  assert.equal(queryInput.options.systemPrompt, 'meeting host');
  assert.equal(queryInput.options.model, 'claude-test-model');
  assert.deepEqual(queryInput.options.mcpServers, { meeting: { type: 'sdk' } });
  assert.deepEqual(queryInput.options.skills, ['review']);
  assert.deepEqual(queryInput.options.settingSources, []);
  assert.deepEqual(queryInput.options.tools, []);
  assert.equal(queryInput.options.resume, 'claude-session-old');
  assert.equal(queryInput.options.effort, 'high');
  assert.deepEqual(queryInput.options.thinking, { type: 'adaptive' });
  assert.deepEqual(session.snapshot(), { protocol: 'claude-agent-sdk', sessionId: 'claude-session-1' });
  session.end();
});

test('Claude worker messages translate to provider-neutral semantic signals', async () => {
  const { mapClaudeMessageToWorkerSignals } = await import(
    '../dist-electron/backends/claude-code-adapter.js'
  );
  const tools = new Map();
  assert.deepEqual(mapClaudeMessageToWorkerSignals({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'tool-1', name: 'Write', input: {} },
      ],
    },
  }, tools), [
    { kind: 'progress', message: 'working' },
    { kind: 'tool', toolName: 'Write', phase: 'started', callId: 'tool-1' },
  ]);
  assert.deepEqual(mapClaudeMessageToWorkerSignals({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
    },
  }, tools), [
    { kind: 'tool', toolName: 'Write', phase: 'completed', callId: 'tool-1', output: 'ok' },
  ]);
  assert.deepEqual(mapClaudeMessageToWorkerSignals({ type: 'result', subtype: 'success' }), [
    { kind: 'ended', reason: 'completed' },
  ]);
  assert.deepEqual(mapClaudeMessageToWorkerSignals({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    },
  }, new Map(), { suppressExpectedSteerBoundary: true }), []);
  assert.deepEqual(mapClaudeMessageToWorkerSignals({
    type: 'result',
    subtype: 'error',
    is_error: true,
    result: 'Request interrupted by user',
  }, new Map(), { suppressExpectedSteerBoundary: true }), []);
  assert.deepEqual(mapClaudeMessageToWorkerSignals({
    type: 'assistant',
    message: {
      content: [{
        type: 'text',
        text: [
          'done',
          '```work-report',
          '{"status":"completed","summary":"ok","files":[],"tests":[],"unresolved":[]}',
          '```',
        ].join('\n'),
      }],
    },
  }), [
    { kind: 'progress', message: 'done' },
    {
      kind: 'delivery',
      report: {
        status: 'completed',
        summary: 'ok',
        files: [],
        tests: [],
        unresolved: [],
      },
    },
  ]);
});

test('Claude Worker steering continues the persistent session without a canonical failure', async () => {
  const pending = [];
  const buffered = [];
  const push = (value) => {
    const resolve = pending.shift();
    if (resolve) resolve({ value, done: false });
    else buffered.push(value);
  };
  const fakeQuery = {
    initializationResult: async () => ({ session_id: 'claude-worker-steer' }),
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (buffered.length > 0) {
        return Promise.resolve({ value: buffered.shift(), done: false });
      }
      return new Promise((resolve) => pending.push(resolve));
    },
    async interrupt() {
      push({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
      });
      push({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Request interrupted by user',
      });
    },
    async setPermissionMode() {},
  };
  const events = [];
  const backend = new ClaudeCodeBackend({ queryFactory: () => fakeQuery });
  const session = backend.createSession({
    cwd: process.cwd(),
    executionRole: 'worker',
  }, (event) => events.push(event));

  await session.start();
  await session.interrupt('steer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);

  session.sendUserText('continue after steering');
  push({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'continued safely' }] },
  });
  push({ type: 'result', subtype: 'success' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    {
      kind: 'worker-signal',
      signal: { kind: 'progress', message: 'continued safely' },
    },
    {
      kind: 'worker-signal',
      signal: { kind: 'ended', reason: 'completed' },
    },
  ]);
  session.end();
});
