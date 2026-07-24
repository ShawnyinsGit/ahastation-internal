import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { snapshotDeliveryFiles } from '../dist-electron/delivery-snapshot.js';

test('delivery snapshots copy and hash a relative in-workspace file asynchronously', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-snapshot-'));
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'ahastation-snapshot-evidence-'));
  await mkdir(join(cwd, 'src'));
  const contents = 'export const ready = true;\n';
  await writeFile(join(cwd, 'src', 'ready.ts'), contents);

  const result = await snapshotDeliveryFiles(
    cwd,
    snapshotRoot,
    'delivery-attempt-1',
    ['src/ready.ts'],
  );
  const snapshot = result.get('src/ready.ts');

  assert.deepEqual(snapshot, {
    snapshotPath: join(snapshotRoot, 'delivery-attempt-1', 'src', 'ready.ts'),
    sizeBytes: Buffer.byteLength(contents),
    sha256: createHash('sha256').update(contents).digest('hex'),
    previewStatus: 'copied',
  });
  assert.equal(
    await readFile(snapshot.snapshotPath, 'utf8'),
    contents,
  );
  await assert.rejects(access(join(cwd, 'deliveries')), /ENOENT/);
});

test('delivery snapshots reject traversal and symlink escapes', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-snapshot-root-'));
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'ahastation-snapshot-evidence-'));
  const outside = await mkdtemp(join(tmpdir(), 'ahastation-snapshot-outside-'));
  const secret = join(outside, 'secret.txt');
  await writeFile(secret, 'must not be copied');

  const escaped = await snapshotDeliveryFiles(cwd, snapshotRoot, 'delivery', [secret, '../outside.txt']);
  assert.equal(escaped.get(secret)?.previewStatus, 'invalid');
  assert.equal(escaped.get('../outside.txt')?.previewStatus, 'invalid');

  const link = join(cwd, 'linked-secret.txt');
  try {
    await symlink(secret, link, 'file');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') {
      t.diagnostic('symlink creation is unavailable on this Windows host');
      return;
    }
    throw error;
  }
  const viaLink = await snapshotDeliveryFiles(cwd, snapshotRoot, 'delivery', ['linked-secret.txt']);
  assert.equal(viaLink.get('linked-secret.txt')?.previewStatus, 'invalid');
});

test('delivery snapshots hash but do not copy files larger than the preview limit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-snapshot-large-'));
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'ahastation-snapshot-evidence-'));
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61);
  await writeFile(join(cwd, 'large.bin'), bytes);

  const result = await snapshotDeliveryFiles(cwd, snapshotRoot, 'delivery', ['large.bin']);
  assert.deepEqual(result.get('large.bin'), {
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    previewStatus: 'too-large',
  });
});
