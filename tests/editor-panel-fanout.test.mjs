import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EDITOR_ACTIVITY_CAP,
  EditorPanelStore,
  resolveFanOutTarget,
} from '../dist-electron/backends/opencode-editor-panel.js';

// ---------------------------------------------------------------------------
// Fan-out routing (§2.2 rule 7): point-to-point, never cross-talk
// ---------------------------------------------------------------------------

test('resolveFanOutTarget routes each hostId to its own window only', () => {
  const bindings = new Map([
    ['worker-a', { webContentsId: 11 }],
    ['worker-b', { webContentsId: 22 }],
  ]);
  assert.equal(resolveFanOutTarget(bindings, 'worker-a'), 11);
  assert.equal(resolveFanOutTarget(bindings, 'worker-b'), 22);
  // No cross-talk: A's events can never resolve to B's window.
  assert.notEqual(resolveFanOutTarget(bindings, 'worker-a'), 22);
});

test('resolveFanOutTarget returns null for unbound or windowless hosts', () => {
  const bindings = new Map([
    ['worker-a', { webContentsId: 11 }],
    ['worker-c', { webContentsId: null }],
  ]);
  assert.equal(resolveFanOutTarget(bindings, 'nobody'), null);
  assert.equal(resolveFanOutTarget(bindings, 'worker-c'), null);
});

// ---------------------------------------------------------------------------
// EditorPanelStore — snapshot shape + incremental events
// ---------------------------------------------------------------------------

test('initial snapshot is empty with idle status', () => {
  const store = new EditorPanelStore(() => 1000);
  assert.deepEqual(store.snapshot(), { status: 'idle', todos: [], diff: [], activity: [] });
});

test('noteText coalesces per message into a single rolling activity entry', () => {
  const store = new EditorPanelStore(() => 1000);
  const e1 = store.noteText('m1', 'Hello');
  assert.equal(e1.kind, 'activity-upsert');
  assert.equal(e1.key, 'text:m1');
  store.noteText('m1', 'Hello world, longer text');
  store.noteText('m2', 'another message');
  const snap = store.snapshot();
  assert.equal(snap.activity.length, 2);
  assert.equal(snap.activity[0].item.label, 'Hello world, longer text');
});

test('noteToolCall upserts by callID across status transitions', () => {
  const store = new EditorPanelStore(() => 1000);
  store.noteToolCall('call_1', 'bash', 'running', { command: 'ls' });
  const ev = store.noteToolCall('call_1', 'bash', 'completed');
  assert.equal(ev.kind, 'activity-upsert');
  const snap = store.snapshot();
  assert.equal(snap.activity.length, 1);
  assert.equal(snap.activity[0].item.label, 'bash · completed');
});

test('setTodos normalizes raw todo payloads into the snapshot', () => {
  const store = new EditorPanelStore(() => 1000);
  const ev = store.setTodos([
    { id: 't1', content: 'write tests', status: 'in_progress', priority: 'high' },
    { content: 'missing id gets derived' },
    'garbage-entry',
  ]);
  assert.equal(ev.kind, 'todo');
  assert.equal(ev.todos.length, 2);
  assert.deepEqual(ev.todos[0], { id: 't1', content: 'write tests', status: 'in_progress', priority: 'high' });
  assert.equal(ev.todos[1].status, 'pending');
  assert.deepEqual(store.snapshot().todos, ev.todos);
});

test('setDiff normalizes file stats and drops fileless entries', () => {
  const store = new EditorPanelStore(() => 1000);
  const ev = store.setDiff([
    { file: 'src/a.ts', additions: 10, deletions: 2, before: 'x', after: 'y' },
    { file: '', additions: 1, deletions: 1 },
    { additions: 3 },
  ]);
  assert.equal(ev.kind, 'diff');
  assert.deepEqual(ev.diff, [{ file: 'src/a.ts', additions: 10, deletions: 2 }]);
});

test('setStatus emits only on transitions; setError also logs activity', () => {
  const store = new EditorPanelStore(() => 1000);
  assert.equal(store.setStatus('idle'), null); // no-op, already idle
  const busy = store.setStatus('busy');
  assert.deepEqual(busy, { kind: 'status', status: 'busy' });
  assert.equal(store.setStatus('busy'), null);
  const errs = store.setError('provider exploded');
  assert.equal(store.getStatus(), 'error');
  assert.equal(errs.length, 2);
  assert.equal(store.snapshot().activity.at(-1).item.kind, 'status');
});

test('instance activity entries are unique and capped', () => {
  const store = new EditorPanelStore(() => 1000);
  store.noteInstanceActivity('编辑文件 a.ts');
  store.noteInstanceActivity('编辑文件 b.ts');
  assert.equal(store.snapshot().activity.length, 2);
  for (let i = 0; i < EDITOR_ACTIVITY_CAP + 10; i += 1) {
    store.noteInstanceActivity(`event ${i}`);
  }
  assert.equal(store.snapshot().activity.length, EDITOR_ACTIVITY_CAP);
});
