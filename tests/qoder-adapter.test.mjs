import assert from 'node:assert/strict';
import { chmod, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { QoderBackend, resolveQoderRuntime } from '../dist-electron/backends/qoder-adapter.js';

class FakeQuery {
  values = [];
  waiters = [];
  interrupted = 0;
  closed = 0;

  initializationResult() {
    return Promise.resolve({ session_id: 'qoder-session-1' });
  }

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.values.length > 0) return Promise.resolve({ value: this.values.shift(), done: false });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  interrupt() { this.interrupted += 1; return Promise.resolve(); }
  close() {
    this.closed += 1;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
    return Promise.resolve();
  }
}

function createHarness() {
  const query = new FakeQuery();
  let call;
  const sdk = {
    query(input) { call = input; return query; },
    qodercliAuth() { return { type: 'qodercli' }; },
    accessToken(token) { return { type: 'accessToken', accessToken: token }; },
  };
  const events = [];
  const backend = new QoderBackend({
    resolveBinary: () => '/fake/qodercli',
    loadSdk: async () => sdk,
  });
  const session = backend.createSession({
    cwd: '/workspace',
    systemPrompt: 'meeting instructions',
    model: 'performance',
    env: { HOME: '/home/test' },
  }, (event) => events.push(event));
  return { backend, session, query, events, getCall: () => call };
}

test('Qoder session uses the official SDK multi-turn interface and reaches real ready', async () => {
  const h = createHarness();
  await h.session.start();

  const call = h.getCall();
  assert.equal(call.options.cwd, '/workspace');
  assert.equal(call.options.pathToQoderCLIExecutable, '/fake/qodercli');
  assert.equal(call.options.model, 'performance');
  assert.equal(call.options.systemPrompt, 'meeting instructions');
  assert.deepEqual(call.options.auth, { type: 'qodercli' });
  assert.equal(call.options.enableFileCheckpointing, true);

  h.query.push({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.events[0].kind, 'message');
  assert.equal(h.events[0].message.message.content[0].text, 'ready');
});

test('Qoder tool permission is resolved through the BackendSession seam', async () => {
  const h = createHarness();
  await h.session.start();
  const pending = h.getCall().options.canUseTool('Bash', { command: 'npm test' }, {
    toolUseID: 'tool-1', signal: new AbortController().signal,
  });
  assert.deepEqual(h.events[0], {
    kind: 'permission-request',
    id: 'tool-1',
    toolName: 'Bash',
    input: { command: 'npm test' },
    toolUseID: 'tool-1',
  });
  h.session.resolvePermission('tool-1', 'allow');
  assert.deepEqual(await pending, {
    behavior: 'allow', updatedInput: { command: 'npm test' }, toolUseID: 'tool-1',
  });
});

test('Qoder interrupt stops only the turn and end closes the SDK session', async () => {
  const h = createHarness();
  await h.session.start();
  await h.session.interrupt();
  assert.equal(h.query.interrupted, 1);
  h.session.end();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.query.closed, 1);
});

test('Qoder auth expiry emits one auth-required circuit breaker event', async () => {
  const h = createHarness();
  await h.session.start();
  h.getCall().options.onAuthExpired();
  h.getCall().options.onAuthExpired();
  assert.deepEqual(h.events, [{
    kind: 'auth-required',
    error: 'Qoder 登录已失效，请重新认证后重连。',
  }]);
});

test('packaged Qoder runtime resolves to an unpacked executable', async (t) => {
  const resources = await mkdtemp(join(tmpdir(), 'ahastation-qoder-resources-'));
  t.after(() => rm(resources, { recursive: true, force: true }));
  const binary = join(resources, 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js');
  await mkdir(join(binary, '..'), { recursive: true });
  await writeFile(binary, '#!/usr/bin/env node\n');
  await chmod(binary, 0o755);
  assert.equal(resolveQoderRuntime(resources, () => null), await realpath(binary));
});

test('failed Qoder readiness handshake closes the spawned SDK session', async () => {
  const query = new FakeQuery();
  query.initializationResult = async () => { throw new Error('protocol mismatch'); };
  const backend = new QoderBackend({
    resolveBinary: () => '/fake/qodercli',
    loadSdk: async () => ({
      query: () => query,
      qodercliAuth: () => ({ type: 'qodercli' }),
      accessToken: (token) => ({ type: 'accessToken', accessToken: token }),
    }),
  });
  const session = backend.createSession({ cwd: '/workspace' }, () => {});
  await assert.rejects(session.start(), /protocol mismatch/);
  assert.equal(query.closed, 1);
});
