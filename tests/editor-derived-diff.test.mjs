import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EditorPanelStore,
  parseUnifiedDiffCounts,
} from '../dist-electron/backends/opencode-editor-panel.js';

// ---------------------------------------------------------------------------
// Derived diff (opencode 1.18.4 session.diff events are always empty —
// live-verified; the panel must derive from tool calls / permission diffs)
// ---------------------------------------------------------------------------

test('parseUnifiedDiffCounts: counts +/- and skips +++/--- headers', () => {
  const diff = [
    'Index: /tmp/hello.txt',
    '===================================================================',
    '--- /tmp/hello.txt',
    '+++ /tmp/hello.txt',
    '@@ -0,0 +1,2 @@',
    '+hi',
    '+world',
    '-old',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiffCounts(diff), { additions: 2, deletions: 1 });
});

test('noteFileChange: upserts entries and upgrades counts later', () => {
  const store = new EditorPanelStore(() => 1000);
  store.noteFileChange('/tmp/a.ts');
  assert.deepEqual(store.snapshot().diff, [{ file: '/tmp/a.ts', additions: 0, deletions: 0 }]);
  store.noteFileChange('/tmp/a.ts', { additions: 5, deletions: 1 });
  store.noteFileChange('/tmp/b.ts', { additions: 2, deletions: 0 });
  assert.deepEqual(store.snapshot().diff, [
    { file: '/tmp/a.ts', additions: 5, deletions: 1 },
    { file: '/tmp/b.ts', additions: 2, deletions: 0 },
  ]);
});

test('setDiff: empty server payload does NOT wipe derived entries (1.18.4 gap)', () => {
  const store = new EditorPanelStore(() => 1000);
  store.noteFileChange('/tmp/a.ts', { additions: 3, deletions: 0 });
  store.setDiff([]); // what 1.18.4 actually sends
  assert.deepEqual(store.snapshot().diff, [{ file: '/tmp/a.ts', additions: 3, deletions: 0 }]);
});

test('setDiff: non-empty server payload wins over derived entries', () => {
  const store = new EditorPanelStore(() => 1000);
  store.noteFileChange('/tmp/derived.ts');
  store.setDiff([{ file: '/tmp/server.ts', additions: 10, deletions: 2 }]);
  assert.deepEqual(store.snapshot().diff, [{ file: '/tmp/server.ts', additions: 10, deletions: 2 }]);
});
