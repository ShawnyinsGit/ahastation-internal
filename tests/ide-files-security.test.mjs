import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
  ideFilesListPayloadSchema,
  ideFilesReadPayloadSchema,
  isPathConfined,
  resolveConfinedPath,
} from '../dist-electron/ipc/ide-files.js';

// ---------------------------------------------------------------------------
// isPathConfined — pure string-level confinement check
// ---------------------------------------------------------------------------

test('isPathConfined accepts the root itself and descendants', () => {
  const root = join(sep, 'a', 'b');
  assert.equal(isPathConfined(root, root), true);
  assert.equal(isPathConfined(root, join(root, 'c')), true);
  assert.equal(isPathConfined(root, join(root, 'c', 'd')), true);
});

test('isPathConfined rejects parents and sibling-prefix traps', () => {
  const root = join(sep, 'a', 'b');
  assert.equal(isPathConfined(root, join(sep, 'a')), false);
  // /a/bc starts with /a/b as a string but is NOT inside it — the trailing
  // separator in the comparison is what keeps this safe.
  assert.equal(isPathConfined(root, join(sep, 'a', 'bc')), false);
  assert.equal(isPathConfined(root, join(sep, 'x', 'y')), false);
});

// ---------------------------------------------------------------------------
// resolveConfinedPath — realpath-based confinement against a real temp tree
// ---------------------------------------------------------------------------

async function makeWorkspace() {
  const base = await mkdtemp(join(tmpdir(), 'ide-files-test-'));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'hello.txt'), 'hello');
  await writeFile(join(root, 'sub', 'inner.txt'), 'inner');
  await writeFile(join(outside, 'secret.txt'), 'top-secret');
  await symlink(outside, join(root, 'escape-link'), 'dir');
  await symlink(join(root, 'sub'), join(root, 'inside-link'), 'dir');
  // macOS /var → /private/var: always compare against the realpath'd root.
  const realRoot = await realpath(root);
  const realOutside = await realpath(outside);
  return { base, root: realRoot, outside: realOutside };
}

test('resolveConfinedPath resolves the root and normal in-tree files', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  const rootResult = await resolveConfinedPath(ws.root);
  assert.equal(rootResult.ok, true);
  assert.equal(rootResult.target, ws.root);

  const fileResult = await resolveConfinedPath(ws.root, join('sub', 'inner.txt'));
  assert.equal(fileResult.ok, true);
  assert.equal(fileResult.target, join(ws.root, 'sub', 'inner.txt'));
});

test('resolveConfinedPath rejects .. traversal outside the root', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  const result = await resolveConfinedPath(ws.root, join('..', 'outside', 'secret.txt'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Path outside workspace');
});

test('resolveConfinedPath rejects absolute paths outside the root', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  const result = await resolveConfinedPath(ws.root, join(ws.outside, 'secret.txt'));
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Path outside workspace');
});

test('resolveConfinedPath rejects symlink escapes (the opencode-files hole)', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  // Symlink inside the root pointing at a directory outside it — the old
  // isPathSafe check passed this because it never resolved symlinks.
  const viaLink = await resolveConfinedPath(ws.root, join('escape-link', 'secret.txt'));
  assert.equal(viaLink.ok, false);
  assert.equal(viaLink.error, 'Path outside workspace');

  const linkItself = await resolveConfinedPath(ws.root, 'escape-link');
  assert.equal(linkItself.ok, false);
});

test('resolveConfinedPath allows symlinks that stay inside the root', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  const result = await resolveConfinedPath(ws.root, join('inside-link', 'inner.txt'));
  assert.equal(result.ok, true);
  assert.equal(result.target, join(ws.root, 'sub', 'inner.txt'));
});

test('resolveConfinedPath reports missing targets as not found (ENOENT)', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  const result = await resolveConfinedPath(ws.root, 'does-not-exist.txt');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'Path not found');
});

// ---------------------------------------------------------------------------
// zod payload schemas — renderer payloads are strictly validated
// ---------------------------------------------------------------------------

test('ide-files:list schema accepts empty and path-only payloads', () => {
  assert.equal(ideFilesListPayloadSchema.safeParse({}).success, true);
  assert.equal(ideFilesListPayloadSchema.safeParse({ path: 'sub/dir' }).success, true);
});

test('ide-files:list schema rejects cwd smuggling and wrong types', () => {
  // The whole point of the redesign: a renderer-supplied cwd must be
  // rejected, not ignored.
  assert.equal(ideFilesListPayloadSchema.safeParse({ cwd: '/' }).success, false);
  assert.equal(ideFilesListPayloadSchema.safeParse({ path: 42 }).success, false);
});

test('ide-files:read schema requires a string path and nothing else', () => {
  assert.equal(ideFilesReadPayloadSchema.safeParse({ path: 'a.txt' }).success, true);
  assert.equal(ideFilesReadPayloadSchema.safeParse({}).success, false);
  assert.equal(ideFilesReadPayloadSchema.safeParse({ path: '' }).success, false);
  assert.equal(ideFilesReadPayloadSchema.safeParse({ path: 123 }).success, false);
  assert.equal(ideFilesReadPayloadSchema.safeParse({ path: 'a.txt', cwd: '/' }).success, false);
});
