import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EditorSceneStore,
  parseEditorScene,
  serializeEditorScene,
} from '../dist-electron/ide/editor-scene.js';
import { planDisplayMigration } from '../dist-electron/display-migration.js';

// ---------------------------------------------------------------------------
// Editor scene: serialize/parse round-trip + store semantics
// ---------------------------------------------------------------------------

test('editor scene serialize/parse round-trips', () => {
  const scene = { hostId: 'worker-a', selectedFile: 'src/app.ts', scrollTop: 240, updatedAt: 1234 };
  const parsed = parseEditorScene(JSON.parse(serializeEditorScene(scene)));
  assert.deepEqual(parsed, scene);
});

test('parseEditorScene rejects drift and tolerates missing optionals', () => {
  assert.equal(parseEditorScene(null), null);
  assert.equal(parseEditorScene('x'), null);
  assert.equal(parseEditorScene({ hostId: '' }), null);
  assert.equal(parseEditorScene({ hostId: 'w', selectedFile: 42 }), null);
  assert.deepEqual(parseEditorScene({ hostId: 'w' }), {
    hostId: 'w', selectedFile: null, scrollTop: 0, updatedAt: 0,
  });
  assert.deepEqual(parseEditorScene({ hostId: 'w', selectedFile: null, scrollTop: -5 }), {
    hostId: 'w', selectedFile: null, scrollTop: 0, updatedAt: 0,
  });
});

test('EditorSceneStore is last-write-wins per hostId', () => {
  const store = new EditorSceneStore();
  store.report({ hostId: 'a', selectedFile: 'old.ts', scrollTop: 10, updatedAt: 100 });
  store.report({ hostId: 'a', selectedFile: 'new.ts', scrollTop: 20, updatedAt: 200 });
  store.report({ hostId: 'a', selectedFile: 'stale.ts', scrollTop: 0, updatedAt: 50 });
  assert.equal(store.get('a').selectedFile, 'new.ts');
  assert.equal(store.get('a').scrollTop, 20);
  store.report({ hostId: 'b', selectedFile: 'b.ts', scrollTop: 1, updatedAt: 1 });
  assert.equal(store.size, 2);
  assert.equal(store.clear('a'), true);
  assert.equal(store.get('a'), null);
});

// ---------------------------------------------------------------------------
// Migration planner (auto mode only)
// ---------------------------------------------------------------------------

test('handheld→desktop with an open overlay migrates it to a window', () => {
  const actions = planDisplayMigration({
    override: 'auto',
    modeBefore: 'handheld',
    modeAfter: 'desktop',
    overlay: { open: true, hostId: 'worker-a' },
    editorWindows: [],
  });
  assert.deepEqual(actions, [{ kind: 'overlay-to-window', hostId: 'worker-a' }]);
});

test('desktop→handheld collapses editor windows into one overlay', () => {
  const actions = planDisplayMigration({
    override: 'auto',
    modeBefore: 'desktop',
    modeAfter: 'handheld',
    overlay: { open: false, hostId: null },
    editorWindows: ['worker-a', 'worker-b'],
  });
  assert.deepEqual(actions, [{ kind: 'window-to-overlay', hostId: 'worker-a' }]);
});

test('no-op cases: same mode, forced override, nothing to migrate', () => {
  assert.deepEqual(planDisplayMigration({
    override: 'auto', modeBefore: 'desktop', modeAfter: 'desktop',
    overlay: { open: true, hostId: 'w' }, editorWindows: ['w'],
  }), []);
  // Forced modes never auto-migrate (setting semantics).
  assert.deepEqual(planDisplayMigration({
    override: 'handheld', modeBefore: 'desktop', modeAfter: 'handheld',
    overlay: { open: false, hostId: null }, editorWindows: ['w'],
  }), []);
  assert.deepEqual(planDisplayMigration({
    override: 'desktop', modeBefore: 'handheld', modeAfter: 'desktop',
    overlay: { open: true, hostId: 'w' }, editorWindows: [],
  }), []);
  // Nothing open in the source form factor.
  assert.deepEqual(planDisplayMigration({
    override: 'auto', modeBefore: 'handheld', modeAfter: 'desktop',
    overlay: { open: false, hostId: null }, editorWindows: [],
  }), []);
  assert.deepEqual(planDisplayMigration({
    override: 'auto', modeBefore: 'desktop', modeAfter: 'handheld',
    overlay: { open: false, hostId: null }, editorWindows: [],
  }), []);
});
