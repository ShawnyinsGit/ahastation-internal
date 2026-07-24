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
  const session = backend.createSession({
    cwd: '/workspace',
    systemPrompt: 'meeting host',
    model: 'claude-test-model',
    mcpServers: { meeting: { type: 'sdk' } },
    skills: ['review'],
    extra: { settingSources: [], tools: [] },
    resumeSessionId: 'claude-session-old',
  }, () => {});

  await session.start();
  assert.equal(queryInput.options.systemPrompt, 'meeting host');
  assert.equal(queryInput.options.model, 'claude-test-model');
  assert.deepEqual(queryInput.options.mcpServers, { meeting: { type: 'sdk' } });
  assert.deepEqual(queryInput.options.skills, ['review']);
  assert.deepEqual(queryInput.options.settingSources, []);
  assert.deepEqual(queryInput.options.tools, []);
  assert.equal(queryInput.options.resume, 'claude-session-old');
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
    { kind: 'tool', toolName: 'Write', phase: 'started' },
  ]);
  assert.deepEqual(mapClaudeMessageToWorkerSignals({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
    },
  }, tools), [
    { kind: 'tool', toolName: 'Write', phase: 'completed', detail: 'ok' },
  ]);
  assert.deepEqual(mapClaudeMessageToWorkerSignals({ type: 'result', subtype: 'success' }), [
    { kind: 'ended', reason: 'completed' },
  ]);
});
