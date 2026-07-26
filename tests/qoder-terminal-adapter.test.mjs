import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QoderTerminalBackend,
  QODER_TERMINAL_PROFILE,
} from '../dist-electron/backends/qoder-terminal-adapter.js';
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
  const backend = new QoderTerminalBackend({
    host,
    resolveBinary: () => '/usr/local/bin/qodercli',
    timersEnabled: false,
    ...overrides,
  });
  t.after(() => host.killAll());
  return { backend, host, spawned };
}

async function createWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-qoder-terminal-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('qoder backend id and capabilities are terminal-shaped', () => {
  const backend = new QoderTerminalBackend({ resolveBinary: () => '/x/qodercli' });
  assert.equal(backend.id, 'qoder-terminal');
  assert.equal(backend.capabilities.executeTasks, true);
  assert.equal(backend.capabilities.coordinate, false);
  assert.equal(backend.resolveBinary(), '/x/qodercli');
});

test('qoder launches with -w workspace and no hook registration', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-basic' } },
    () => {},
  );
  await session.start();
  assert.equal(spawned.length, 1);
  const { file, args, options } = spawned[0];
  assert.equal(file, '/usr/local/bin/qodercli');
  assert.deepEqual(args.slice(0, 2), ['-w', cwd]);
  assert.equal(options.cwd, cwd);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  // Hookless: the shared events file still exists (skeleton-managed) but no
  // CLI flag references the hook script.
  assert.ok(!args.some((a) => a.includes('terminal-stop-hook')));
  session.end();
});

test('approval tier and model map to qoder CLI flags', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const s1 = backend.createSession(
    { cwd, extra: { workerId: 'qw-read' }, autoApproveScope: 'read', model: 'auto' },
    () => {},
  );
  await s1.start();
  const atIdx = spawned[0].args.indexOf('--allowed-tools');
  assert.ok(atIdx > 0);
  assert.ok(spawned[0].args[atIdx + 1].includes('Read'));
  const mIdx = spawned[0].args.indexOf('--model');
  assert.equal(spawned[0].args[mIdx + 1], 'auto');
  s1.end();

  const s2 = backend.createSession(
    { cwd, extra: { workerId: 'qw-all' }, autoApproveScope: 'all' },
    () => {},
  );
  await s2.start();
  assert.ok(spawned[1].args.includes('--yolo'));
  s2.end();

  const s3 = backend.createSession(
    { cwd, extra: { workerId: 'qw-off' } },
    () => {},
  );
  await s3.start();
  assert.ok(!spawned[2].args.includes('--yolo'));
  assert.ok(!spawned[2].args.includes('--allowed-tools'));
  s3.end();
});

test('task prompt is pasted once ready; hookless => no automatic turn events', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-flow' } },
    (event) => events.push(event),
  );
  session.sendUserText('任务提示词');
  await session.start();
  assert.deepEqual(spawned[0].pty.writes, [
    `${PASTE_START}任务提示词${PASTE_END}`,
    '\r',
  ]);
  // Startup progress only; never an automatic ended/delivery signal.
  assert.ok(events.some((e) => e.signal?.kind === 'progress'));
  assert.ok(events.every((e) => e.signal?.kind !== 'ended'));
  assert.ok(events.every((e) => e.signal?.kind !== 'delivery'));
  session.end();
});

test('end() kills the pty and cleans the skeleton hook files', async (t) => {
  const { backend, host, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-end' } },
    (event) => events.push(event),
  );
  await session.start();
  const ahaDir = join(cwd, '.aha');
  assert.ok(existsSync(join(ahaDir, 'terminal-turn-events-qw-end.jsonl')));

  session.end();
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(host.has('qw-end'), false);
  assert.ok(!existsSync(join(ahaDir, 'terminal-stop-hook-qw-end.cjs')));
  assert.ok(!existsSync(join(ahaDir, 'terminal-turn-events-qw-end.jsonl')));
  assert.ok(events.every((e) => !(e.signal?.kind === 'ended' && e.signal.reason === 'crashed')));
  session.end();
});

test('missing qodercli fails fast without spawning a pty', async (t) => {
  const { backend, spawned } = createFixture(t, { resolveBinary: () => null });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'qw-nobin' } },
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
  assert.equal(QODER_TERMINAL_PROFILE.id, 'qoder-terminal');
  assert.equal(typeof QODER_TERMINAL_PROFILE.startupMessage, 'string');
  assert.ok(QODER_TERMINAL_PROFILE.missingBinaryMessage.includes('qodercli'));
  // Hookless by design.
  assert.equal(QODER_TERMINAL_PROFILE.registerTurnHook, undefined);
});
