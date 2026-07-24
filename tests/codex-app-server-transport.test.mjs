import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import {
  CodexAppServerTransport,
  extractCodexRuntimeVersion,
} from '../dist-electron/backends/codex-app-server-transport.js';

function fakeAppServer() {
  const process = new EventEmitter();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.killed = false;
  process.kill = () => { process.killed = true; process.emit('exit', 0, 'SIGTERM'); return true; };
  const methods = [];
  process.stdin = new Writable({
    write(chunk, _encoding, done) {
      for (const line of String(chunk).trim().split('\n')) {
        if (!line) continue;
        const message = JSON.parse(line);
        methods.push(message.method);
        queueMicrotask(() => {
          if (message.method === 'initialize') {
            process.stdout.write(`${JSON.stringify({ id: message.id, result: {
              userAgent: 'Codex/0.144.1', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos',
            } })}\n`);
          } else if (message.method === 'account/read') {
            process.stdout.write(`${JSON.stringify({ id: message.id, result: {
              account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true,
            } })}\n`);
          } else if (message.method === 'thread/start') {
            process.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } })}\n`);
          } else if (message.method === 'thread/resume') {
            process.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId } } })}\n`);
          } else if (message.method === 'turn/start') {
            process.stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })}\n`);
          } else if (message.method === 'turn/interrupt') {
            process.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
          }
        });
      }
      done();
    },
  });
  return { process, methods };
}

test('app-server readiness uses initialize and account/read without a model turn', async () => {
  const fake = fakeAppServer();
  const transport = new CodexAppServerTransport({
    binaryPath: '/fake/codex', env: {}, spawnProcess: () => fake.process,
  });
  const ready = await transport.start();
  assert.equal(ready.userAgent, 'Codex/0.144.1');
  assert.equal(ready.account.type, 'chatgpt');
  assert.deepEqual(fake.methods, ['initialize', 'initialized', 'account/read']);
  transport.close();
});

test('app-server starts, resumes and interrupts native threads', async () => {
  const fake = fakeAppServer();
  const notifications = [];
  const transport = new CodexAppServerTransport({
    binaryPath: '/fake/codex', env: {}, spawnProcess: () => fake.process,
    onNotification: (notification) => notifications.push(notification),
  });
  await transport.start();
  assert.equal(await transport.openThread({ cwd: '/workspace', sandbox: 'read-only', approvalPolicy: 'never' }), 'thread-1');
  assert.equal(await transport.resumeThread('thread-restored', { cwd: '/workspace' }), 'thread-restored');
  assert.equal(await transport.startTurn('thread-restored', [{ type: 'text', text: 'hello', text_elements: [] }]), 'turn-1');
  await transport.interruptTurn('thread-restored', 'turn-1');
  fake.process.stdout.write(`${JSON.stringify({ method: 'warning', params: { message: 'fixture' } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications[0].method, 'warning');
  transport.close();
});

test('app-server accepts api key credentials when oauth account is absent', async () => {
  const fake = fakeAppServer();
  const originalWrite = fake.process.stdin._write.bind(fake.process.stdin);
  fake.process.stdin._write = function (chunk, encoding, done) {
    const message = JSON.parse(String(chunk));
    if (message.method === 'account/read') {
      queueMicrotask(() => fake.process.stdout.write(`${JSON.stringify({
        id: message.id, result: { account: null, requiresOpenaiAuth: true },
      })}\n`));
      done();
      return;
    }
    originalWrite(chunk, encoding, done);
  };
  const transport = new CodexAppServerTransport({
    binaryPath: '/fake/codex',
    env: { OPENAI_API_KEY: 'sk-third-party' },
    spawnProcess: () => fake.process,
  });
  const ready = await transport.start();
  assert.equal(ready.account.type, 'api_key');
  transport.close();
});

test('app-server rejects readiness when the authoritative account is absent', async () => {
  const fake = fakeAppServer();
  const originalWrite = fake.process.stdin._write.bind(fake.process.stdin);
  fake.process.stdin._write = function (chunk, encoding, done) {
    const message = JSON.parse(String(chunk));
    if (message.method === 'account/read') {
      queueMicrotask(() => fake.process.stdout.write(`${JSON.stringify({
        id: message.id, result: { account: null, requiresOpenaiAuth: true },
      })}\n`));
      done();
      return;
    }
    originalWrite(chunk, encoding, done);
  };
  const transport = new CodexAppServerTransport({
    binaryPath: '/fake/codex', env: {}, spawnProcess: () => fake.process,
  });
  await assert.rejects(transport.start(), /authentication required/i);
  transport.close();
});

test('app-server rejects a runtime that does not match its locked schema', async () => {
  const fake = fakeAppServer();
  const originalWrite = fake.process.stdin._write.bind(fake.process.stdin);
  fake.process.stdin._write = function (chunk, encoding, done) {
    const message = JSON.parse(String(chunk));
    if (message.method === 'initialize') {
      queueMicrotask(() => fake.process.stdout.write(`${JSON.stringify({
        id: message.id, result: { userAgent: 'Codex Desktop/0.145.0 (macOS)' },
      })}\n`));
      done();
      return;
    }
    originalWrite(chunk, encoding, done);
  };
  const transport = new CodexAppServerTransport({
    binaryPath: '/fake/codex', env: {}, spawnProcess: () => fake.process,
  });
  await assert.rejects(transport.start(), /requires 0\.144\.1/);
  transport.close();
});

test('Codex runtime version is extracted from the real desktop user agent shape', () => {
  assert.equal(
    extractCodexRuntimeVersion('Codex Desktop/0.144.1 (Mac OS; arm64) dumb (ahastation; 0.15.1)'),
    '0.144.1',
  );
});
