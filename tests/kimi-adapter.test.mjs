import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildKimiCommandArgs,
  hasUsableKimiCredentials,
  KimiBackend,
  parseKimiStreamEvent,
  mapKimiAcpUpdateToWorkerSignal,
  finalizeKimiWorkerText,
  resolveKimiReadPath,
  resolveKimiWritePath,
  withKimiSystemPrompt,
} from '../dist-electron/backends/kimi-adapter.js';

test('Kimi Code 0.24 uses supported one-shot stream-json arguments', () => {
  assert.deepEqual(buildKimiCommandArgs({ prompt: 'hello', model: 'kimi-k2' }), [
    '--prompt', 'hello',
    '--output-format', 'stream-json',
    '--model', 'kimi-k2',
  ]);
});

test('Kimi follow-up turns resume the exact CLI session', () => {
  assert.deepEqual(buildKimiCommandArgs({ prompt: 'next', sessionId: 'session_123' }), [
    '--session', 'session_123',
    '--prompt', 'next',
    '--output-format', 'stream-json',
  ]);
});

test('Kimi stream parser captures assistant text and resume hints', () => {
  assert.deepEqual(
    parseKimiStreamEvent('{"role":"assistant","content":"hello"}'),
    {
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        raw: { role: 'assistant', content: 'hello' },
      },
    },
  );
  assert.deepEqual(
    parseKimiStreamEvent('{"role":"meta","type":"session.resume_hint","session_id":"session_123"}'),
    { sessionId: 'session_123' },
  );
});

test('Kimi session readiness does not spend a model turn', async () => {
  const backend = new KimiBackend();
  backend.resolveBinary = () => '/usr/bin/false';
  const events = [];
  const session = backend.createSession({
    cwd: process.cwd(),
    systemPrompt: 'host instructions',
  }, (event) => events.push(event));

  await assert.doesNotReject(() => session.start());
  assert.deepEqual(events, []);
  session.end();
});

test('Kimi authentication failure emits one auth-required circuit breaker', async (t) => {
  if (process.platform === 'win32') {
    t.skip('fixture is a POSIX shell executable');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-kimi-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'kimi');
  await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"error":{"message":"401 Unauthorized","code":"unauthorized"}}\'\nexit 1\n');
  await chmod(binary, 0o755);
  const backend = new KimiBackend();
  backend.resolveBinary = () => binary;
  const events = [];
  const session = backend.createSession({ cwd: process.cwd() }, (event) => events.push(event));

  await session.start();
  session.sendUserText('hello');
  const deadline = Date.now() + 1_000;
  while (events.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(events.filter((event) => event.kind === 'auth-required').length, 1);
  assert.equal(events.some((event) => event.kind === 'error'), false);
  session.end();
});

test('Kimi credential probe rejects stale or malformed files instead of trusting existence', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-kimi-creds-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  await writeFile(path, '{not json');
  assert.equal(hasUsableKimiCredentials(path, 2_000), false);
  await writeFile(path, JSON.stringify({ access_token: 'old', expires_at: 1_000 }));
  assert.equal(hasUsableKimiCredentials(path, 2_000), false);
  await writeFile(path, JSON.stringify({ refresh_token: 'refresh', expires_at: 1_000 }));
  assert.equal(hasUsableKimiCredentials(path, 2_000), true);
});

test('Kimi applies the system prompt to a first multimodal turn', () => {
  assert.deepEqual(withKimiSystemPrompt(
    [{ type: 'image', data: 'abc', mimeType: 'image/png' }], 'expert rules', true,
  ), [
    { type: 'text', text: 'expert rules\n\n---\n\n' },
    { type: 'image', data: 'abc', mimeType: 'image/png' },
  ]);
});

test('Kimi ACP worker updates and terminal reports use the shared contract', () => {
  assert.deepEqual(mapKimiAcpUpdateToWorkerSignal({
    sessionUpdate: 'tool_call_update',
    title: 'Edit file',
    status: 'completed',
  }), {
    kind: 'tool',
    toolName: 'Edit file',
    phase: 'completed',
    detail: 'Edit file',
  });
  const report = {
    status: 'completed',
    summary: 'done',
    files: [{ path: 'src/app.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'passed' }],
    unresolved: [],
  };
  assert.deepEqual(
    finalizeKimiWorkerText(`\`\`\`work-report\n${JSON.stringify(report)}\n\`\`\``),
    [
      { kind: 'delivery', report },
      { kind: 'ended', reason: 'completed' },
    ],
  );
  assert.equal(finalizeKimiWorkerText('done')[0].code, 'missing-work-report');
});

test('Kimi ACP worker writes stay inside an existing workspace parent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-kimi-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // resolveKimiWritePath returns realpath-canonical targets so macOS
  // /var → /private/var aliases compare equal to the confined root.
  const realRoot = await realpath(root);
  assert.equal(
    await resolveKimiWritePath(root, 'result.txt'),
    join(realRoot, 'result.txt'),
  );
  await assert.rejects(
    resolveKimiWritePath(root, '../outside.txt'),
    /outside the Meeting workspace/,
  );
});

test('Kimi ACP worker runs writable mode and emits a strict delivery contract', async () => {
  const events = [];
  const modes = [];
  let transportOptions;
  const report = {
    status: 'completed',
    summary: 'implemented',
    files: [{ path: 'src/app.ts', action: 'modified' }],
    tests: [{ command: 'npm test', status: 'passed' }],
    unresolved: [],
  };
  const backend = new KimiBackend({
    createAcpTransport(options) {
      transportOptions = options;
      return {
        async start() {
          return {
            protocolVersion: 1,
            agentInfo: { name: 'Kimi Code CLI', version: '0.24.1' },
          };
        },
        async authenticate() {},
        async newSession() { return 'kimi-worker-1'; },
        async resumeSession(id) { return id; },
        async setMode(_id, mode) { modes.push(mode); },
        async prompt() {
          options.onNotification({
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `\`\`\`work-report\n${JSON.stringify(report)}\n\`\`\``,
                },
              },
            },
          });
          return { stopReason: 'end_turn' };
        },
        cancel() {},
        close() {},
      };
    },
  });
  backend.resolveBinary = () => '/fake/kimi';
  const session = backend.createSession({
    cwd: process.cwd(),
    executionRole: 'worker',
    extra: { kimiTransport: 'acp' },
  }, (event) => events.push(event));
  await session.start();
  assert.equal(transportOptions.allowWriteTextFile, true);
  assert.deepEqual(modes, ['default']);
  session.sendUserText('do it');
  const deadline = Date.now() + 1_000;
  while (!events.some((event) => event.kind === 'worker-signal'
    && event.signal.kind === 'ended') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(events, [
    { kind: 'worker-signal', signal: { kind: 'delivery', report } },
    { kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } },
  ]);
  session.end();
});

test('Kimi ACP file reads reject symlinks escaping the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-kimi-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'ahastation-kimi-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await writeFile(join(outside, 'secret.txt'), 'secret');
  try {
    await symlink(join(outside, 'secret.txt'), join(root, 'linked-secret.txt'));
  } catch (error) {
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      t.skip('Windows Developer Mode or symlink privilege is unavailable');
      return;
    }
    throw error;
  }
  await assert.rejects(
    resolveKimiReadPath(root, 'linked-secret.txt'),
    /outside the Meeting workspace/,
  );
});
