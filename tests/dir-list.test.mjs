import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isHiddenName,
  listSubdirs,
  sortDirEntries,
} from '../dist-electron/dir-list.js';

// ---------------------------------------------------------------------------
// isHiddenName / sortDirEntries — pure helpers
// ---------------------------------------------------------------------------

test('isHiddenName treats dot-prefixed names as hidden', () => {
  assert.equal(isHiddenName('.git'), true);
  assert.equal(isHiddenName('.'), true);
  assert.equal(isHiddenName('src'), false);
  assert.equal(isHiddenName('a.b'), false);
});

test('sortDirEntries sorts case-insensitively and does not mutate input', () => {
  const input = [
    { name: 'banana', path: '/x/banana' },
    { name: 'Apple', path: '/x/Apple' },
    { name: 'cherry', path: '/x/cherry' },
  ];
  const sorted = sortDirEntries(input);
  assert.deepEqual(sorted.map((e) => e.name), ['Apple', 'banana', 'cherry']);
  assert.deepEqual(input.map((e) => e.name), ['banana', 'Apple', 'cherry']);
});

// ---------------------------------------------------------------------------
// listSubdirs — against a real temp tree
// ---------------------------------------------------------------------------

async function makeTree() {
  const base = await mkdtemp(join(tmpdir(), 'dir-list-test-'));
  await mkdir(join(base, 'alpha'));
  await mkdir(join(base, 'Beta'));
  await mkdir(join(base, '.hidden'));
  await writeFile(join(base, 'file.txt'), 'not a dir');
  // Symlink to a real directory should be listed; a broken one skipped.
  await symlink(join(base, 'alpha'), join(base, 'alpha-link'), 'dir');
  await symlink(join(base, 'missing'), join(base, 'broken-link'), 'dir');
  return base;
}

test('listSubdirs lists only directories, hides dot-dirs by default, sorted', async (t) => {
  const base = await makeTree();
  t.after(() => rm(base, { recursive: true, force: true }));

  const entries = await listSubdirs(base, false);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['alpha', 'alpha-link', 'Beta'],
  );
  for (const e of entries) {
    assert.equal(e.path, join(base, e.name));
  }
});

test('listSubdirs includes dot-dirs when showHidden is true', async (t) => {
  const base = await makeTree();
  t.after(() => rm(base, { recursive: true, force: true }));

  const entries = await listSubdirs(base, true);
  assert.deepEqual(
    entries.map((e) => e.name),
    ['.hidden', 'alpha', 'alpha-link', 'Beta'],
  );
});

test('listSubdirs throws for a missing directory', async () => {
  await assert.rejects(() => listSubdirs('/nonexistent-dir-list-test-path', false));
});
