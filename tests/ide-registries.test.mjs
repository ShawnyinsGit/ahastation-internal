import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SERVER_LIFECYCLE_MATRIX,
  OpencodeServerRegistry,
  serverKeyOf,
} from '../dist-electron/ide/opencode/opencode-server-registry.js';
import {
  IdeRegistry,
  resolveIdeForHost,
} from '../dist-electron/ide/ide-registry.js';
import {
  NO_EDITOR_CAPABILITIES,
  parseEditorCapabilities,
  serializeEditorCapabilities,
} from '../dist-electron/ide/ide-adapter.js';
import { OPENCODE_EDITOR_CAPABILITIES } from '../dist-electron/ide/opencode/opencode-editor-adapter.js';

// ---------------------------------------------------------------------------
// Server registry: key derivation + refcount
// ---------------------------------------------------------------------------

test('serverKeyOf derives a stable key from (meetingId, cwd)', () => {
  assert.equal(serverKeyOf('m1', '/a'), serverKeyOf('m1', '/a'));
  assert.notEqual(serverKeyOf('m1', '/a'), serverKeyOf('m2', '/a'));
  assert.notEqual(serverKeyOf('m1', '/a'), serverKeyOf('m1', '/b'));
});

function fakeHandle(url) {
  return {
    url,
    password: 'pw',
    pid: 99999999,
    killCalls: 0,
    exitCbs: [],
    kill() { this.killCalls += 1; },
    onExit(cb) { this.exitCbs.push(cb); },
  };
}

function makeServerRegistry({ records = [], probe = async () => false } = {}) {
  let saved = null;
  const registry = new OpencodeServerRegistry({
    probe,
    load: () => records,
    save: (r) => { saved = r; },
    now: () => 1000,
  });
  return { registry, getSaved: () => saved };
}

test('acquire shares one server per key and releases kill at refcount 0', async () => {
  const { registry } = makeServerRegistry();
  const handle = fakeHandle('http://127.0.0.1:4096');
  const spawn = async () => handle;

  const key = serverKeyOf('m1', '/work');
  const a = await registry.acquire({ meetingId: 'm1', cwd: '/work', spawn });
  const b = await registry.acquire({ meetingId: 'm1', cwd: '/work', spawn });
  assert.equal(a.key, key);
  assert.equal(b.handle, handle); // same shared server
  assert.equal(registry.refcount(key), 2);
  assert.equal(registry.size(), 1);

  await registry.release(key);
  assert.equal(registry.refcount(key), 1);
  assert.equal(handle.killCalls, 0); // still shared
  await registry.release(key);
  assert.equal(handle.killCalls, 1); // last release kills
  assert.equal(registry.size(), 0);
});

test('different meetings on the same cwd get separate servers', async () => {
  const { registry } = makeServerRegistry();
  const h1 = fakeHandle('http://127.0.0.1:4096');
  const h2 = fakeHandle('http://127.0.0.1:56017');
  const spawns = [h1, h2];
  const spawn = async () => spawns.shift();
  await registry.acquire({ meetingId: 'm1', cwd: '/work', spawn });
  await registry.acquire({ meetingId: 'm2', cwd: '/work', spawn });
  assert.equal(registry.size(), 2);
});

// ---------------------------------------------------------------------------
// Server registry: adopt-or-kill + lifecycle matrix + exit cleanup
// ---------------------------------------------------------------------------

test('adopt-or-kill adopts a live orphan and sweeps dead ones', async () => {
  const records = [
    { meetingId: 'old', cwd: '/work', pid: 99999998, url: 'http://127.0.0.1:4096', password: 'pw', startedAt: 1 },
    { meetingId: 'old', cwd: '/work', pid: 99999999, url: 'http://127.0.0.1:4097', password: 'pw2', startedAt: 2 },
  ];
  const probe = async (url) => url === 'http://127.0.0.1:4096'; // first is alive
  const { registry } = makeServerRegistry({ records, probe });
  let spawnCalled = false;
  const acquired = await registry.acquire({
    meetingId: 'm1',
    cwd: '/work',
    spawn: async () => { spawnCalled = true; return fakeHandle('http://new'); },
  });
  assert.equal(spawnCalled, false); // adopted, not spawned
  assert.equal(acquired.handle.url, 'http://127.0.0.1:4096');
  assert.equal(registry.refcount(acquired.key), 1);
});

test('adopt-or-kill spawns fresh when no orphan is alive', async () => {
  const records = [
    { meetingId: 'old', cwd: '/work', pid: 99999999, url: 'http://127.0.0.1:4096', password: 'pw', startedAt: 1 },
  ];
  const { registry } = makeServerRegistry({ records, probe: async () => false });
  const handle = fakeHandle('http://new');
  const acquired = await registry.acquire({ meetingId: 'm1', cwd: '/work', spawn: async () => handle });
  assert.equal(acquired.handle, handle);
});

test('lifecycle matrix: windowClose keeps, meetingDelete kills regardless of refcount', async () => {
  assert.equal(SERVER_LIFECYCLE_MATRIX.sessionEnd, 'release');
  assert.equal(SERVER_LIFECYCLE_MATRIX.windowClose, 'keep');
  assert.equal(SERVER_LIFECYCLE_MATRIX.appQuit, 'kill-all');
  assert.equal(SERVER_LIFECYCLE_MATRIX.meetingDelete, 'kill');

  const { registry } = makeServerRegistry();
  const handle = fakeHandle('http://x');
  const key = serverKeyOf('m1', '/work');
  const spawn = async () => handle;
  await registry.acquire({ meetingId: 'm1', cwd: '/work', spawn });
  await registry.acquire({ meetingId: 'm1', cwd: '/work', spawn });
  assert.equal(registry.refcount(key), 2);

  await registry.handleLifecycle('windowClose', key);
  assert.equal(registry.refcount(key), 2); // kept

  await registry.handleLifecycle('meetingDelete', key);
  assert.equal(handle.killCalls, 1); // killed despite refcount 2
  assert.equal(registry.size(), 0);
});

test('appQuit kills every server; server self-exit drops it from the registry', async () => {
  const { registry } = makeServerRegistry();
  const h1 = fakeHandle('http://a');
  const h2 = fakeHandle('http://b');
  const spawns = [h1, h2];
  const spawn = async () => spawns.shift();
  await registry.acquire({ meetingId: 'm1', cwd: '/w1', spawn });
  await registry.acquire({ meetingId: 'm2', cwd: '/w2', spawn });

  // Self-exit: registry drops the dead server.
  h1.exitCbs.forEach((cb) => cb(0, 'SIGTERM'));
  assert.equal(registry.size(), 1);

  await registry.handleLifecycle('appQuit');
  assert.equal(h2.killCalls, 1);
  assert.equal(registry.size(), 0);
});

// ---------------------------------------------------------------------------
// IDE registry: resolution order + persistence + detection sanitize
// ---------------------------------------------------------------------------

test('resolveIdeForHost: per-host override wins over default', () => {
  const state = { defaultIdeId: 'opencode', perHostOverride: { 'worker-a': 'hermes' } };
  assert.equal(resolveIdeForHost(state, 'worker-a'), 'hermes');
  assert.equal(resolveIdeForHost(state, 'worker-b'), 'opencode');
});

function makeIdeRegistry({ stored = {}, detections = [] } = {}) {
  let saved = null;
  const registry = new IdeRegistry({
    load: () => stored,
    save: (s) => { saved = s; },
    detect: async () => detections,
  });
  return { registry, getSaved: () => saved };
}

const OPENCODE_DETECTED = { id: 'opencode', installed: true, version: '1.18.4' };

test('IdeRegistry init merges detection and persists sanitized state', async () => {
  const { registry, getSaved } = makeIdeRegistry({
    stored: { defaultIdeId: 'hermes', perHostOverride: { 'w1': 'hermes', 'w2': 'opencode' } },
    detections: [OPENCODE_DETECTED, { id: 'hermes', installed: false, version: null }],
  });
  await registry.init();
  const state = registry.getState();
  // Persisted default pointed at an uninstalled IDE → sanitized to opencode.
  assert.equal(state.defaultIdeId, 'opencode');
  // Override to uninstalled hermes dropped, opencode override kept.
  assert.deepEqual(state.perHostOverride, { w2: 'opencode' });
  const opencode = state.ides.find((i) => i.id === 'opencode');
  assert.equal(opencode.installed, true);
  assert.equal(opencode.version, '1.18.4');
  assert.equal(state.ides.find((i) => i.id === 'hermes').comingSoon, true);
  assert.deepEqual(getSaved().defaultIdeId, 'opencode');
});

test('setDefault / setOverride persist and reject uninstalled IDEs', async () => {
  const { registry, getSaved } = makeIdeRegistry({ detections: [OPENCODE_DETECTED] });
  await registry.init();

  assert.equal(registry.setDefault('hermes').ok, false);
  assert.equal(registry.setDefault('opencode').ok, true);
  assert.equal(registry.resolveAdapterForHost('w1')?.id, 'opencode');

  assert.equal(registry.setOverride('w1', 'hermes').ok, false);
  assert.equal(registry.setOverride('w1', 'opencode').ok, true);
  assert.equal(registry.getState().perHostOverride.w1, 'opencode');
  assert.equal(registry.setOverride('w1', null).ok, true); // clear
  assert.equal('w1' in registry.getState().perHostOverride, false);
  assert.equal(getSaved().perHostOverride.w1 ?? null, null);
});

// ---------------------------------------------------------------------------
// Capabilities round-trip + degrade shape
// ---------------------------------------------------------------------------

test('capabilities serialize/parse round-trips the UI-relevant flags', () => {
  const serialized = serializeEditorCapabilities(OPENCODE_EDITOR_CAPABILITIES);
  const parsed = parseEditorCapabilities(serialized);
  assert.deepEqual(parsed, OPENCODE_EDITOR_CAPABILITIES);
  assert.equal(parsed.fileWrite, false); // never true, even if smuggled
});

test('degraded IDE (all-false capabilities) parses to every panel hidden', () => {
  const parsed = parseEditorCapabilities(serializeEditorCapabilities(NO_EDITOR_CAPABILITIES));
  assert.deepEqual(parsed, NO_EDITOR_CAPABILITIES);
  assert.deepEqual(parseEditorCapabilities(''), NO_EDITOR_CAPABILITIES);
  assert.deepEqual(parseEditorCapabilities(null), NO_EDITOR_CAPABILITIES);
});
