import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CodexBackend, codexLoginArgs } from '../dist-electron/backends/codex-adapter.js';
import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { resolveBinaryFromPath } from '../dist-electron/backends/subprocess-backend.js';
import { removeBackendAuth, setBackendAuth } from '../dist-electron/store.js';

test('packaged runtime resolver finds the canonical Kimi Code install directory', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'ahastation-kimi-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const binary = join(home, '.kimi-code', 'bin', 'kimi');
  await mkdir(join(home, '.kimi-code', 'bin'), { recursive: true });
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  assert.equal(resolveBinaryFromPath('kimi'), binary);
});

test('Codex auth status is based on the CLI probe, not config.toml existence', async () => {
  await removeBackendAuth('codex');
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    execFile: () => {
      throw Object.assign(new Error('Not logged in'), { status: 1, stderr: 'Not logged in\n' });
    },
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: false });
});

test('Codex auth status treats a saved API key as logged in', async (t) => {
  await setBackendAuth('codex', { authMode: 'apikey', apiKey: 'sk-test' });
  t.after(async () => { await removeBackendAuth('codex'); });
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    execFile: () => {
      throw new Error('CLI auth probe should not run when an API key is saved');
    },
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: true });
});

test('Codex buildEnv normalizes trailing slashes on OPENAI_BASE_URL', () => {
  const backend = new CodexBackend();
  const env = backend.buildEnv({
    authMode: 'apikey',
    apiKey: 'sk-test',
    baseUrl: 'https://gateway.example/v1/',
  });
  assert.equal(env.OPENAI_BASE_URL, 'https://gateway.example/v1');
  assert.equal(env.OPENAI_API_KEY, 'sk-test');
});

test('Codex auth status accepts a successful CLI status probe', async () => {
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    execFile: () => 'Logged in using ChatGPT\n',
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: true });
});

test('Codex auth status trusts exit zero when the CLI writes success to stderr', async () => {
  const backend = new CodexBackend({
    resolveBinary: () => '/fake/codex',
    // Codex 0.144.1 writes "Logged in using ChatGPT" to stderr, so
    // execFileSync returns an empty stdout string on a successful probe.
    execFile: () => '',
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: true });
});

test('Claude auth status is based on the CLI JSON probe, not binary existence', async () => {
  const backend = new ClaudeCodeBackend({
    resolveBinary: () => '/fake/claude',
    execFile: () => '{"loggedIn":false,"authMethod":"none"}\n',
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: false });
});

test('Claude auth status accepts a successful machine-readable probe', async () => {
  const backend = new ClaudeCodeBackend({
    resolveBinary: () => '/fake/claude',
    execFile: () => '{"loggedIn":true,"authMethod":"oauth"}\n',
  });
  assert.deepEqual(await backend.checkAuthStatus(), { loggedIn: true });
});

test('Codex OAuth uses the login subcommand supported by the locked runtime', () => {
  assert.deepEqual(codexLoginArgs(), ['login']);
});
