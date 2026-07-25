import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ClaudeTerminalBackend,
  TERMINAL_TURN_ENDED_MARKER,
  TERMINAL_TURN_ENDED_MESSAGE,
  buildPasteFrame,
  parseTurnEventLines,
} from '../dist-electron/backends/claude-terminal-adapter.js';
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
  const backend = new ClaudeTerminalBackend({
    host,
    resolveBinary: () => '/usr/local/bin/claude',
    timersEnabled: false,
    ...overrides,
  });
  t.after(() => host.killAll());
  return { backend, host, spawned };
}

async function createWorkspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-terminal-adapter-'));
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

test('bracketed paste frame wraps the payload without submitting it', () => {
  assert.equal(buildPasteFrame('line1\nline2'), `${PASTE_START}line1\nline2${PASTE_END}`);
  // The frame itself never carries the submit key.
  assert.ok(!buildPasteFrame('text').includes('\r'));
});

test('turn event parser is fail-open per line', () => {
  const chunk = [
    '{"kind":"stop","at":1}',
    'garbage-not-json',
    '{"noKind":true}',
    '  {"kind":"stop","at":2}  ',
    '{"kind":"other"}',
    '{"kind":"st', // torn mid-append
  ].join('\n');
  assert.deepEqual(parseTurnEventLines(chunk), [
    { kind: 'stop' },
    { kind: 'stop' },
    { kind: 'other' },
  ]);
});

test('turn-ended message starts with the renderer marker', () => {
  assert.ok(TERMINAL_TURN_ENDED_MESSAGE.startsWith(TERMINAL_TURN_ENDED_MARKER));
});

test('messages queued before readiness are pasted once the TUI is ready', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'w-paste' } },
    (event) => events.push(event),
  );
  // Queued pre-start: nothing is written anywhere yet.
  session.sendUserText('任务提示词 第一行\n第二行');
  assert.equal(spawned.length, 0);

  await session.start();
  assert.equal(spawned.length, 1);
  // timersEnabled:false → ready immediately → paste frame then submit \r.
  assert.deepEqual(spawned[0].pty.writes, [
    `${PASTE_START}任务提示词 第一行\n第二行${PASTE_END}`,
    '\r',
  ]);
  // Follow-up steering pastes immediately.
  session.sendUserContent([{ type: 'text', text: '追加指令' }]);
  assert.deepEqual(spawned[0].pty.writes.slice(2), [
    `${PASTE_START}追加指令${PASTE_END}`,
    '\r',
  ]);
  // Never emits ended(completed) — only progress-level signals so far.
  assert.ok(events.every((e) => e.signal?.kind !== 'ended'));
  session.end();
});

test('claude binary is launched with the per-session Stop hook settings', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'w-args' }, model: 'claude-sonnet-4-20250514' },
    () => {},
  );
  await session.start();
  const { file, args, options } = spawned[0];
  assert.equal(file, '/usr/local/bin/claude');
  assert.equal(args[0], '--settings');
  assert.ok(args[1].endsWith('terminal-claude-settings-w-args.json'));
  assert.deepEqual(args.slice(2), ['--model', 'claude-sonnet-4-20250514']);
  assert.equal(options.cwd, cwd);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(existsSync(join(cwd, '.aha', 'terminal-stop-hook-w-args.cjs')));
  session.end();
});

test('Stop hook events surface as turn-ended progress signals', async (t) => {
  const { backend } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'w-stop' } },
    (event) => events.push(event),
  );
  await session.start();
  const eventsPath = join(cwd, '.aha', 'terminal-turn-events-w-stop.jsonl');
  await appendFile(eventsPath, `${JSON.stringify({ kind: 'stop', at: Date.now() })}\n`);
  await waitFor(() => events.some(
    (e) => e.signal?.kind === 'progress'
      && e.signal.message.startsWith(TERMINAL_TURN_ENDED_MARKER),
  ));
  const turnEnded = events.filter(
    (e) => e.signal?.kind === 'progress'
      && e.signal.message.startsWith(TERMINAL_TURN_ENDED_MARKER),
  );
  assert.equal(turnEnded.length, 1);
  assert.equal(turnEnded[0].signal.message, TERMINAL_TURN_ENDED_MESSAGE);
  // The turn boundary must NOT end the session or claim completion.
  assert.ok(events.every((e) => e.signal?.kind !== 'ended'));
  assert.ok(events.every((e) => e.signal?.kind !== 'delivery'));
  session.end();
});

test('end() kills the pty and removes the hook plumbing files', async (t) => {
  const { backend, host, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'w-end' } },
    (event) => events.push(event),
  );
  await session.start();
  const ahaDir = join(cwd, '.aha');
  assert.ok(existsSync(join(ahaDir, 'terminal-claude-settings-w-end.json')));

  session.end();
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(host.has('w-end'), false);
  assert.ok(!existsSync(join(ahaDir, 'terminal-claude-settings-w-end.json')));
  assert.ok(!existsSync(join(ahaDir, 'terminal-stop-hook-w-end.cjs')));
  assert.ok(!existsSync(join(ahaDir, 'terminal-turn-events-w-end.jsonl')));
  // Deliberate shutdown never surfaces as a crash.
  assert.ok(events.every((e) => !(e.signal?.kind === 'ended' && e.signal.reason === 'crashed')));
  // Idempotent.
  session.end();
});

test('unexpected pty exit is reported as a crash', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'w-crash' } },
    (event) => events.push(event),
  );
  await session.start();
  spawned[0].pty.emitExit(1);
  assert.ok(events.some(
    (e) => e.signal?.kind === 'ended' && e.signal.reason === 'crashed',
  ));
  session.end();
});

test('missing claude CLI fails fast without spawning a pty', async (t) => {
  const { backend, spawned } = createFixture(t, { resolveBinary: () => null });
  const cwd = await createWorkspace(t);
  const events = [];
  const session = backend.createSession(
    { cwd, extra: { workerId: 'w-nobin' } },
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

test('interrupt sends Esc — Claude TUI\'s native stop key', async (t) => {
  const { backend, spawned } = createFixture(t);
  const cwd = await createWorkspace(t);
  const session = backend.createSession(
    { cwd, extra: { workerId: 'w-esc' } },
    () => {},
  );
  await session.start();
  await session.interrupt();
  assert.equal(spawned[0].pty.writes.at(-1), '\u001b');
  session.end();
});
