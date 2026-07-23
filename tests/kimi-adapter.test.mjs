import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildKimiCommandArgs,
  hasUsableKimiCredentials,
  KimiBackend,
  parseKimiStreamEvent,
  resolveKimiReadPath,
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

test('Kimi ACP file reads reject symlinks escaping the workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-kimi-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'ahastation-kimi-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(root, 'linked-secret.txt'));
  await assert.rejects(
    resolveKimiReadPath(root, 'linked-secret.txt'),
    /outside the Meeting workspace/,
  );
});
