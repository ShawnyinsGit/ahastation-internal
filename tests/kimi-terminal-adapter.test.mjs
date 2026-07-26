import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KimiTerminalBackend,
  KIMI_TERMINAL_PROFILE,
} from '../dist-electron/backends/kimi-terminal-adapter.js';
import { TERMINAL_TURN_ENDED_MARKER } from '../dist-electron/backends/terminal-cli-adapter.js';
import { PtyHost } from '../dist-electron/pty-host.js';

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

function createFakePty() {
  return {
    pid: 7,
    writes: [],
    killed: false,
    dataHandlers: [],
    exitHandlers: [],
    onData(cb) { this.dataHandlers.push(cb); return { dispose: () => {} }; },
    onExit(cb) { this.exitHandlers.push(cb); return { dispose: () => {} }; },
    write(data) { this.writes.push(data); },
    resize() {},
    kill() { this.killed = true; },
    emitData(data) { for (const cb of [...this.dataHandlers]) cb(data); },
    emitExit(exitCode) { for (const cb of [...this.exitHandlers]) cb({ exitCode }); },
  };
}

function createFixture(t, overrides = {}) {
  const spawned = [];
  const host = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty();
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });
  const backend = new KimiTerminalBackend({
    host,
    resolveBinary: () => '/usr/local/bin/kimi',
    timersEnabled: false,
    ...overrides,
  });
  t.after(() => host.killAll());
  return { backend, host, spawned };
}

async function createWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-kimi-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) return resolve(undefined);
      if (Date.now() - startedAt > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('kimi backend id and capabilities are terminal-shaped', () => {
  const backend = new KimiTerminalBackend({ resolveBinary: () => '/x/kimi' });
  assert.equal(backend.id, 'kimi-code-terminal');
  assert.equal(backend.capabilities.executeTasks, true);
  assert.equal(backend.capabilities.coordinate, false);
  assert.equal(backend.resolveBinary(), '/x/kimi');
});

test('kimi launches with a managed KIMI_CODE_HOME carrying the Stop hook', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'kw-hook' } },
    () => {},
  );
  await session.start();
  assert.equal(spawned.length, 1);
  const { file, args, options } = spawned[0];
  assert.equal(file, '/usr/local/bin/kimi');
  // No --settings flag: hook registration is env-based.
  assert.ok(!args.includes('--settings'));
  const kimiHome = options.env.KIMI_CODE_HOME;
  assert.ok(kimiHome, 'KIMI_CODE_HOME must be set');
  assert.ok(kimiHome.startsWith(join(cwd, '.aha')));
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  const configToml = await readFile(join(kimiHome, 'config.toml'), 'utf8');
  assert.ok(configToml.includes('[[hooks]]'));
  assert.ok(configToml.includes('event = "Stop"'));
  assert.ok(configToml.includes('terminal-stop-hook-kw-hook.cjs'));
  // The shared hook script exists next to the managed home.
  assert.ok(existsSync(join(cwd, '.aha', 'terminal-stop-hook-kw-hook.cjs')));
  session.end();
});

test('login state entries are symlinked from the real kimi home when present', async (t) => {
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'kw-links' } },
    () => {},
  );
  await session.start();
  const kimiHome = join(cwd, '.aha', 'kimi-home-kw-links');
  // Best-effort: entries only exist when the machine has a real ~/.kimi-code.
  // Whatever exists must be a symlink, never a copied file.
  for (const name of ['oauth', 'credentials', 'device_id', 'workspaces.json', 'tui.toml']) {
    const p = join(kimiHome, name);
    if (existsSync(p)) assert.ok(lstatSync(p).isSymbolicLink(), `${name} must be a symlink`);
  }
  session.end();
});

test('approval tier and model map to kimi CLI flags', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const s1 = backend.createSession(
    { cwd, extra: { workerId: 'kw-read' }, autoApproveScope: 'read', model: 'kimi-latest' },
    () => {},
  );
  await s1.start();
  assert.deepEqual(spawned[0].args, ['-m', 'kimi-latest', '-y']);
  s1.end();

  const s2 = backend.createSession(
    { cwd, extra: { workerId: 'kw-all' }, autoApproveScope: 'all' },
    () => {},
  );
  await s2.start();
  assert.deepEqual(spawned[1].args, ['--auto']);
  s2.end();

  const s3 = backend.createSession(
    { cwd, extra: { workerId: 'kw-off' } },
    () => {},
  );
  await s3.start();
  assert.deepEqual(spawned[2].args, []);
  s3.end();
});

test('task prompt is pasted once ready; Stop hook surfaces turn-ended', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'kw-flow' } },
    (event) => events.push(event),
  );
  session.sendUserText('任务提示词');
  await session.start();
  assert.deepEqual(spawned[0].pty.writes, [
    `${PASTE_START}任务提示词${PASTE_END}`,
    '\r',
  ]);
  const eventsPath = join(cwd, '.aha', 'terminal-turn-events-kw-flow.jsonl');
  await appendFile(eventsPath, `${JSON.stringify({ kind: 'stop', at: Date.now() })}\n`);
  await waitFor(() => events.some(
    (e) => e.signal?.kind === 'progress' && e.signal.message.startsWith(TERMINAL_TURN_ENDED_MARKER),
  ));
  assert.ok(events.every((e) => e.signal?.kind !== 'ended'));
  assert.ok(events.every((e) => e.signal?.kind !== 'delivery'));
  session.end();
});

test('end() kills the pty and removes the managed home and hook files', async (t) => {
  const { backend, host, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'kw-end' } },
    (event) => events.push(event),
  );
  await session.start();
  const ahaDir = join(cwd, '.aha');
  assert.ok(existsSync(join(ahaDir, 'kimi-home-kw-end', 'config.toml')));

  session.end();
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(host.has('kw-end'), false);
  assert.ok(!existsSync(join(ahaDir, 'kimi-home-kw-end')));
  assert.ok(!existsSync(join(ahaDir, 'terminal-stop-hook-kw-end.cjs')));
  assert.ok(!existsSync(join(ahaDir, 'terminal-turn-events-kw-end.jsonl')));
  assert.ok(events.every((e) => !(e.signal?.kind === 'ended' && e.signal.reason === 'crashed')));
  session.end();
});

test('missing kimi CLI fails fast without spawning a pty', async (t) => {
  const { backend, spawned } = createFixture(t, { resolveBinary: () => null });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'kw-nobin' } },
    (event) => events.push(event),
  );
  await session.start();
  assert.equal(spawned.length, 0);
  assert.ok(events.some(
    (e) => e.signal?.kind === 'failed' && e.signal.code === 'runtime-unavailable',
  ));
  assert.ok(events.some(
    (e) => e.signal?.kind === 'ended' && e.signal.reason === 'crashed',
  ));
  session.end();
});

test('profile metadata is consistent', () => {
  assert.equal(KIMI_TERMINAL_PROFILE.id, 'kimi-code-terminal');
  assert.equal(typeof KIMI_TERMINAL_PROFILE.startupMessage, 'string');
  assert.ok(KIMI_TERMINAL_PROFILE.missingBinaryMessage.includes('kimi'));
});
