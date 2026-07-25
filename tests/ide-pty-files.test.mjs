import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildPtyResizeBody,
  encodePtyData,
  idePtyInputSchema,
  idePtyResizeSchema,
  PtyInputLimiter,
  PtySessionBook,
  PTY_INPUT_MAX_BYTES,
} from '../dist-electron/ipc/ide-pty.js';
import {
  ideFilesWritePayloadSchema,
  isMtimeConflict,
  resolveConfinedWriteTarget,
} from '../dist-electron/ipc/ide-files.js';
import { shikiLangForPath } from '../dist-electron/ide/editor-highlight.js';

// ---------------------------------------------------------------------------
// PTY: input limiter (size + rate)
// ---------------------------------------------------------------------------

test('PtyInputLimiter drops frames over 8KB', () => {
  const limiter = new PtyInputLimiter();
  assert.equal(limiter.allow(PTY_INPUT_MAX_BYTES, 1000), true);
  assert.equal(limiter.allow(PTY_INPUT_MAX_BYTES + 1, 1000), false);
  assert.equal(limiter.dropped, 1);
});

test('PtyInputLimiter caps at 60 frames per second and resets each second', () => {
  const limiter = new PtyInputLimiter();
  for (let i = 0; i < 60; i += 1) {
    assert.equal(limiter.allow(10, 5000), true, `frame ${i} should pass`);
  }
  assert.equal(limiter.allow(10, 5000), false);
  assert.equal(limiter.allow(10, 5999), false);
  assert.equal(limiter.dropped, 2);
  assert.equal(limiter.allow(10, 6000), true); // next second resets
});

// ---------------------------------------------------------------------------
// PTY: one session per window
// ---------------------------------------------------------------------------

test('PtySessionBook enforces one PTY per window', () => {
  const book = new PtySessionBook();
  assert.equal(book.setIfAbsent(1, 'pty_a'), true);
  assert.equal(book.setIfAbsent(1, 'pty_b'), false); // already has one
  assert.equal(book.get(1), 'pty_a');
  assert.equal(book.get(2), null);
  assert.equal(book.remove(1), true);
  assert.equal(book.setIfAbsent(1, 'pty_b'), true); // free to recreate
  assert.equal(book.size, 1);
});

// ---------------------------------------------------------------------------
// PTY: resize payload + downlink encoding + schemas
// ---------------------------------------------------------------------------

test('buildPtyResizeBody shapes {size:{rows,cols}} with clamping', () => {
  assert.deepEqual(buildPtyResizeBody(24, 80), { size: { rows: 24, cols: 80 } });
  assert.deepEqual(buildPtyResizeBody(0, 9999), { size: { rows: 1, cols: 500 } });
  assert.deepEqual(buildPtyResizeBody(43.7, 132.2), { size: { rows: 43, cols: 132 } });
});

test('encodePtyData passes text through and base64-encodes binary', () => {
  assert.deepEqual(encodePtyData('ls -la\r\n'), { kind: 'pty-data', data: 'ls -la\r\n', encoding: 'utf8' });
  const bin = encodePtyData(Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]));
  assert.equal(bin.kind, 'pty-data');
  assert.equal(bin.encoding, 'base64');
  assert.deepEqual([...Buffer.from(bin.data, 'base64')], [0x1b, 0x5b, 0x33, 0x31, 0x6d]);
});

test('pty schemas validate payloads strictly', () => {
  assert.equal(idePtyInputSchema.safeParse({ data: 'x' }).success, true);
  assert.equal(idePtyInputSchema.safeParse({ data: '' }).success, false);
  assert.equal(idePtyInputSchema.safeParse({ data: 'x', ptyId: 'smuggle' }).success, false);
  assert.equal(idePtyResizeSchema.safeParse({ rows: 24, cols: 80 }).success, true);
  assert.equal(idePtyResizeSchema.safeParse({ rows: 0, cols: 80 }).success, false);
  assert.equal(idePtyResizeSchema.safeParse({ rows: 24.5, cols: 80 }).success, false);
});

// ---------------------------------------------------------------------------
// File write: schema, mtime conflict, confined target resolution
// ---------------------------------------------------------------------------

test('ide-files:write schema accepts valid payloads and rejects bad ones', () => {
  assert.equal(ideFilesWritePayloadSchema.safeParse({ path: 'a.ts', content: 'x' }).success, true);
  assert.equal(ideFilesWritePayloadSchema.safeParse({ path: 'a.ts', content: 'x', expectedMtime: 123 }).success, true);
  assert.equal(ideFilesWritePayloadSchema.safeParse({ path: 'a.ts' }).success, false);
  assert.equal(ideFilesWritePayloadSchema.safeParse({ path: 'a.ts', content: 'x', cwd: '/' }).success, false);
  assert.equal(ideFilesWritePayloadSchema.safeParse({ path: 'a.ts', content: 'y'.repeat(512 * 1024 + 1) }).success, false);
});

test('isMtimeConflict has a 1ms epsilon', () => {
  assert.equal(isMtimeConflict(1000, 1000), false);
  assert.equal(isMtimeConflict(1000, 1001), false);
  assert.equal(isMtimeConflict(1000, 1002), true);
});

async function makeWorkspace() {
  const base = await mkdtemp(join(tmpdir(), 'ide-write-test-'));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'exists.txt'), 'old');
  let symlinksAvailable = true;
  try {
    await symlink(outside, join(root, 'escape-link'), 'dir');
  } catch (error) {
    if (error?.code !== 'EPERM') throw error;
    symlinksAvailable = false;
  }
  return {
    base,
    root: await realpath(root),
    outside: await realpath(outside),
    symlinksAvailable,
  };
}

test('resolveConfinedWriteTarget resolves existing files and rejects escapes', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  const existing = await resolveConfinedWriteTarget(ws.root, 'exists.txt');
  assert.equal(existing.ok, true);
  assert.equal(existing.target, join(ws.root, 'exists.txt'));

  assert.equal((await resolveConfinedWriteTarget(ws.root, join(ws.outside, 'x.txt'))).ok, false);
  assert.equal((await resolveConfinedWriteTarget(ws.root, join('..', 'outside', 'x.txt'))).ok, false);
  if (ws.symlinksAvailable) {
    assert.equal((await resolveConfinedWriteTarget(ws.root, join('escape-link', 'x.txt'))).ok, false);
  }
});

test('resolveConfinedWriteTarget allows new files inside the root only', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.base, { recursive: true, force: true }));

  const created = await resolveConfinedWriteTarget(ws.root, join('sub', 'new-file.txt'));
  assert.equal(created.ok, true);
  assert.equal(created.target, join(ws.root, 'sub', 'new-file.txt'));

  // Missing parent directory → not found.
  assert.equal((await resolveConfinedWriteTarget(ws.root, join('nope', 'x.txt'))).ok, false);
});

// ---------------------------------------------------------------------------
// shiki extension → language mapping
// ---------------------------------------------------------------------------

test('shikiLangForPath maps known extensions and falls back to null', () => {
  assert.equal(shikiLangForPath('src/app.ts'), 'typescript');
  assert.equal(shikiLangForPath('src/App.tsx'), 'tsx');
  assert.equal(shikiLangForPath('script.PY'), 'python');
  assert.equal(shikiLangForPath('README.md'), 'markdown');
  assert.equal(shikiLangForPath('a/b/c.rs'), 'rust');
  assert.equal(shikiLangForPath('fix.diff'), 'diff');
  assert.equal(shikiLangForPath('Main.kt'), 'kotlin');
  assert.equal(shikiLangForPath('App.vue'), 'vue');
  assert.equal(shikiLangForPath('styles.scss'), 'scss');
  assert.equal(shikiLangForPath('query.gql'), 'graphql');
  assert.equal(shikiLangForPath('C:\\proj\\src\\util.ts'), 'typescript');
  assert.equal(shikiLangForPath('archive.unknownext'), null);
  assert.equal(shikiLangForPath('Makefile'), null);
  assert.equal(shikiLangForPath('.gitignore'), null);
});
