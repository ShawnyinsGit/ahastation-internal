import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PtyRingBuffer,
  PTY_RING_BUFFER_MAX_BYTES,
  PtyHost,
} from '../dist-electron/pty-host.js';

/** Minimal fake IPty matching the PtyProcess surface. */
function createFakePty() {
  const pty = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: false,
    dataHandlers: [],
    exitHandlers: [],
    onData(cb) {
      this.dataHandlers.push(cb);
      return { dispose: () => { this.dataHandlers = this.dataHandlers.filter((h) => h !== cb); } };
    },
    onExit(cb) {
      this.exitHandlers.push(cb);
      return { dispose: () => { this.exitHandlers = this.exitHandlers.filter((h) => h !== cb); } };
    },
    write(data) { this.writes.push(data); },
    resize(cols, rows) { this.resizes.push({ cols, rows }); },
    kill() { this.killed = true; },
    emitData(data) { for (const cb of [...this.dataHandlers]) cb(data); },
    emitExit(exitCode) { for (const cb of [...this.exitHandlers]) cb({ exitCode }); },
  };
  return pty;
}

function createHost() {
  const spawned = [];
  const host = new PtyHost({
    spawn: (file, args, options) => {
      const pty = createFakePty();
      spawned.push({ file, args, options, pty });
      return pty;
    },
  });
  return { host, spawned };
}

const SPAWN_OPTS = { file: 'claude', args: [], cwd: process.cwd(), env: { PATH: 'x' } };

test('ring buffer replays pushed chunks in order', () => {
  const buffer = new PtyRingBuffer();
  buffer.push('hello ');
  buffer.push('world');
  assert.equal(buffer.snapshot().toString('utf8'), 'hello world');
  assert.equal(buffer.byteLength, 11);
});

test('ring buffer drops whole chunks from the front past the cap', () => {
  const buffer = new PtyRingBuffer(10);
  buffer.push('aaaa'); // 4
  buffer.push('bbbb'); // 8
  buffer.push('cccc'); // 12 -> drop 'aaaa'
  assert.equal(buffer.snapshot().toString('utf8'), 'bbbbcccc');
  assert.equal(buffer.byteLength, 8);
});

test('ring buffer keeps only the tail of one oversized chunk', () => {
  const buffer = new PtyRingBuffer(4);
  buffer.push('0123456789');
  assert.equal(buffer.snapshot().toString('utf8'), '6789');
  assert.equal(buffer.byteLength, 4);
});

test('default ring buffer cap is ~200KB', () => {
  assert.equal(PTY_RING_BUFFER_MAX_BYTES, 200 * 1024);
});

test('one id gets exactly one pty', () => {
  const { host } = createHost();
  host.spawn('w1', SPAWN_OPTS);
  assert.equal(host.has('w1'), true);
  assert.throws(() => host.spawn('w1', SPAWN_OPTS), /already has a live PTY/);
  host.kill('w1');
  assert.equal(host.has('w1'), false);
  // After kill the slot is free again.
  host.spawn('w1', SPAWN_OPTS);
  assert.equal(host.has('w1'), true);
  host.killAll();
});

test('output is buffered for replay and mirrored to subscribers', () => {
  const { host, spawned } = createHost();
  host.spawn('w1', SPAWN_OPTS);
  const seen = [];
  const unsubscribe = host.onData('w1', (data) => seen.push(data));
  spawned[0].pty.emitData('early ');
  unsubscribe();
  spawned[0].pty.emitData('late');
  assert.deepEqual(seen, ['early ']);
  // Replay contains everything regardless of live subscription windows.
  assert.equal(host.replayBuffer('w1').toString('utf8'), 'early late');
  assert.equal(host.replayBuffer('missing'), null);
  host.killAll();
});

test('write reaches the pty only while it is alive', () => {
  const { host, spawned } = createHost();
  host.spawn('w1', SPAWN_OPTS);
  assert.equal(host.write('w1', 'ls\r'), true);
  assert.deepEqual(spawned[0].pty.writes, ['ls\r']);
  spawned[0].pty.emitExit(0);
  assert.equal(host.write('w1', 'nope'), false);
  assert.equal(host.write('missing', 'nope'), false);
});

test('resize clamps rows/cols into [1, 500] and maps to pty (cols, rows)', () => {
  const { host, spawned } = createHost();
  host.spawn('w1', SPAWN_OPTS);
  assert.equal(host.resize('w1', 0, 9_999), true);
  assert.deepEqual(spawned[0].pty.resizes, [{ cols: 500, rows: 1 }]);
  assert.equal(host.resize('w1', 30, 100), true);
  assert.deepEqual(spawned[0].pty.resizes.at(-1), { cols: 100, rows: 30 });
  assert.equal(host.resize('missing', 10, 10), false);
  host.killAll();
});

test('pty exit notifies subscribers and disposes the session', () => {
  const { host, spawned } = createHost();
  host.spawn('w1', SPAWN_OPTS);
  const exits = [];
  host.onExit('w1', (code) => exits.push(code));
  spawned[0].pty.emitExit(3);
  assert.deepEqual(exits, [3]);
  assert.equal(host.has('w1'), false);
  assert.equal(host.replayBuffer('w1'), null);
});

test('kill terminates the process and clears the slot', () => {
  const { host, spawned } = createHost();
  host.spawn('w1', SPAWN_OPTS);
  host.kill('w1');
  assert.equal(spawned[0].pty.killed, true);
  assert.equal(host.has('w1'), false);
  // Idempotent for unknown ids.
  host.kill('w1');
});

test('spawn passes an xterm-256color terminal with string-only env', () => {
  const { host, spawned } = createHost();
  host.spawn('w1', {
    file: 'claude',
    args: ['--settings', 's.json'],
    cwd: '/tmp/task',
    env: { GOOD: 'yes', BAD: undefined },
  });
  const { options, file, args } = spawned[0];
  assert.equal(file, 'claude');
  assert.deepEqual(args, ['--settings', 's.json']);
  assert.equal(options.name, 'xterm-256color');
  assert.equal(options.cols, 100);
  assert.equal(options.rows, 30);
  assert.deepEqual(options.env, { GOOD: 'yes' });
  host.killAll();
});
