import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  prepareFrozenDeliveryCandidate,
} from '../dist-electron/delivery-candidate.js';
import {
  buildDeliveryDiffManifest,
} from '../dist-electron/delivery-diff.js';
import {
  completeCoordinatorReview,
  confirmCoordinatorReviewEvidence,
  createCoordinatorReviewSession,
  getCoordinatorReviewChunk,
  replaceCoordinatorReviewCandidate,
  submitCoordinatorChunkReview,
} from '../dist-electron/coordinator-review.js';

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim();
}

function makeRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'ahastation-review-'));
  git(cwd, ['init']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'AhaStation Test']);
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'app.ts'), 'export const value = 1;\n');
  git(cwd, ['add', '--', 'src/app.ts']);
  git(cwd, ['commit', '-m', 'base']);
  return { cwd, base: git(cwd, ['rev-parse', 'HEAD']) };
}

function report(files) {
  return {
    status: 'completed',
    summary: 'implemented the requested change',
    files,
    tests: [{ command: 'node --test', status: 'passed' }],
    unresolved: [],
  };
}

function verification() {
  return { passed: true, checks: [{ status: 'passed', command: 'node --test' }] };
}

test('candidate preparation freezes only reported paths and is idempotent', async () => {
  const { cwd, base } = makeRepository();
  writeFileSync(join(cwd, 'src', 'app.ts'), 'export const value = 2;\n');

  const first = await prepareFrozenDeliveryCandidate({
    order: {
      deliveryId: 'delivery-1',
      taskId: 'task-1',
      attempt: 1,
      meetingId: 'meeting-1',
      goal: 'change value',
      acceptanceCriteria: [],
      workspace: cwd,
      sourceRevision: base,
    },
    report: report([{ path: 'src/app.ts', action: 'modified' }]),
    verification: verification(),
    now: () => 100,
    id: () => 'candidate-1',
  });

  assert.equal(first.commit, git(cwd, ['rev-parse', 'HEAD']));
  assert.equal(first.tree, git(cwd, ['rev-parse', 'HEAD^{tree}']));
  assert.equal(first.baseRevision, base);
  assert.equal(first.reportedPaths.length, 1);
  assert.equal(first.manifest.files[0].path, 'src/app.ts');
  assert.match(first.diffHash, /^[a-f0-9]{64}$/);

  const second = await prepareFrozenDeliveryCandidate({
    order: {
      deliveryId: 'delivery-1',
      taskId: 'task-1',
      attempt: 1,
      meetingId: 'meeting-1',
      goal: 'change value',
      acceptanceCriteria: [],
      workspace: cwd,
      sourceRevision: base,
    },
    report: report([{ path: 'src/app.ts', action: 'modified' }]),
    verification: verification(),
    now: () => 200,
    id: () => 'candidate-2',
  });
  assert.equal(second.commit, first.commit);
  assert.equal(second.reportHash, first.reportHash);
});

test('candidate preparation refuses unreported or unchanged paths', async () => {
  const { cwd, base } = makeRepository();
  writeFileSync(join(cwd, 'src', 'app.ts'), 'export const value = 2;\n');
  writeFileSync(join(cwd, 'src', 'extra.ts'), 'export const extra = true;\n');

  await assert.rejects(
    prepareFrozenDeliveryCandidate({
      order: {
        deliveryId: 'delivery-2',
        taskId: 'task-2',
        attempt: 1,
        meetingId: 'meeting-1',
        goal: 'change value',
        acceptanceCriteria: [],
        workspace: cwd,
        sourceRevision: base,
      },
      report: report([{ path: 'src/app.ts', action: 'modified' }]),
      verification: verification(),
    }),
    /unreported changes.*src\/extra\.ts/,
  );
  assert.equal(git(cwd, ['rev-parse', 'HEAD']), base);
});

test('diff manifest is deterministic and withholds suspected secrets', async () => {
  const { cwd, base } = makeRepository();
  writeFileSync(
    join(cwd, 'src', 'app.ts'),
    'export const value = 2;\nexport const token = "sk-abcdefghijklmnop";\n',
  );
  git(cwd, ['add', '--', 'src/app.ts']);
  git(cwd, ['commit', '-m', 'candidate']);
  const candidate = git(cwd, ['rev-parse', 'HEAD']);

  const first = await buildDeliveryDiffManifest({
    workspace: cwd,
    baseRevision: base,
    candidateRevision: candidate,
    maxChunkBytes: 1_024,
    maxChunkLines: 4,
  });
  const second = await buildDeliveryDiffManifest({
    workspace: cwd,
    baseRevision: base,
    candidateRevision: candidate,
    maxChunkBytes: 1_024,
    maxChunkLines: 4,
  });

  assert.deepEqual(second, first);
  assert.equal(first.files.length, 1);
  assert.equal(first.files[0].requiresUserConfirmation, true);
  assert.equal(first.chunks[0].kind, 'secret-withheld');
  assert.equal(first.chunks[0].content, undefined);
  assert.equal(JSON.stringify(first).includes('sk-abcdefghijklmnop'), false);
  assert.equal(
    first.chunks.filter((chunk) => chunk.kind === 'text').every((chunk) => chunk.byteLength <= 1_024),
    true,
  );
  assert.equal(
    first.chunks.filter((chunk) => chunk.kind === 'text').every((chunk) => chunk.lineCount <= 4),
    true,
  );
});

test('diff manifest types binary, oversized, symlink, submodule, rename, and mode evidence', async () => {
  const { cwd, base } = makeRepository();
  writeFileSync(join(cwd, 'asset.bin'), Buffer.from([0, 255, 1, 254, 2, 253]));
  writeFileSync(join(cwd, 'large.txt'), `${'large change\n'.repeat(200)}`);
  git(cwd, ['mv', 'src/app.ts', 'src/main.ts']);
  git(cwd, ['add', '--', 'asset.bin', 'large.txt']);
  git(cwd, ['update-index', '--chmod=+x', 'src/main.ts']);
  const symlinkBlob = git(cwd, ['hash-object', '-w', '--stdin'], {
    input: 'src/main.ts',
  });
  git(cwd, ['update-index', '--add', '--cacheinfo', `120000,${symlinkBlob},app-link`]);
  git(cwd, ['update-index', '--add', '--cacheinfo', `160000,${base},vendor/example`]);
  git(cwd, ['commit', '-m', 'typed evidence']);
  const candidate = git(cwd, ['rev-parse', 'HEAD']);

  const manifest = await buildDeliveryDiffManifest({
    workspace: cwd,
    baseRevision: base,
    candidateRevision: candidate,
    maxChunkBytes: 1_024,
    maxChunkLines: 20,
    maxInlineFileBytes: 1_024,
  });
  const byPath = new Map(manifest.files.map((file) => [file.path, file]));

  assert.equal(byPath.get('asset.bin').kind, 'binary');
  assert.equal(byPath.get('asset.bin').requiresUserConfirmation, true);
  assert.equal(byPath.get('large.txt').kind, 'oversized');
  assert.equal(byPath.get('app-link').kind, 'symlink');
  assert.equal(byPath.get('vendor/example').kind, 'submodule');
  assert.equal(byPath.get('src/main.ts').status, 'renamed');
  assert.equal(byPath.get('src/main.ts').previousPath, 'src/app.ts');
  assert.equal(byPath.get('src/main.ts').kind, 'mode-only');
  assert.equal(
    manifest.chunks
      .filter((chunk) => chunk.kind !== 'text')
      .every((chunk) => chunk.content === undefined && chunk.requiresUserConfirmation),
    true,
  );
});

test('text diff chunks obey configured byte and line bounds', async () => {
  const { cwd, base } = makeRepository();
  writeFileSync(
    join(cwd, 'src', 'app.ts'),
    Array.from({ length: 60 }, (_, index) => `export const value${index} = ${index};`).join('\n'),
  );
  git(cwd, ['add', '--', 'src/app.ts']);
  git(cwd, ['commit', '-m', 'chunked text']);

  const manifest = await buildDeliveryDiffManifest({
    workspace: cwd,
    baseRevision: base,
    candidateRevision: git(cwd, ['rev-parse', 'HEAD']),
    maxChunkBytes: 1_024,
    maxChunkLines: 4,
  });
  const chunks = manifest.chunks.filter((chunk) => chunk.path === 'src/app.ts');

  assert.equal(chunks.length > 1, true);
  assert.equal(chunks.every((chunk) => chunk.kind === 'text'), true);
  assert.equal(chunks.every((chunk) => chunk.byteLength <= 1_024), true);
  assert.equal(chunks.every((chunk) => chunk.lineCount <= 4), true);
});

test('review requires complete hashed coverage and explicit confirmation for withheld evidence', () => {
  const candidate = {
    schemaVersion: 1,
    id: 'candidate-1',
    deliveryId: 'delivery-1',
    taskId: 'task-1',
    attempt: 1,
    workspace: 'C:/workspace',
    baseRevision: 'a'.repeat(40),
    commit: 'b'.repeat(40),
    tree: 'c'.repeat(40),
    reportHash: 'd'.repeat(64),
    verificationHash: 'e'.repeat(64),
    diffHash: 'f'.repeat(64),
    reportedPaths: ['src/app.ts', 'asset.bin'],
    createdAt: 1,
    manifest: {
      schemaVersion: 1,
      baseRevision: 'a'.repeat(40),
      candidateRevision: 'b'.repeat(40),
      diffHash: 'f'.repeat(64),
      files: [
        {
          path: 'src/app.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          oldMode: '100644',
          newMode: '100644',
          kind: 'text',
          chunkIds: ['chunk-1'],
          requiresUserConfirmation: false,
        },
        {
          path: 'asset.bin',
          status: 'modified',
          additions: null,
          deletions: null,
          oldMode: '100644',
          newMode: '100644',
          kind: 'binary',
          chunkIds: ['chunk-2'],
          requiresUserConfirmation: true,
        },
      ],
      chunks: [
        {
          id: 'chunk-1',
          index: 0,
          path: 'src/app.ts',
          kind: 'text',
          hash: '1'.repeat(64),
          lineCount: 1,
          byteLength: 8,
          content: '+change\n',
          requiresUserConfirmation: false,
        },
        {
          id: 'chunk-2',
          index: 1,
          path: 'asset.bin',
          kind: 'binary',
          hash: '2'.repeat(64),
          lineCount: 0,
          byteLength: 128,
          requiresUserConfirmation: true,
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
    },
  };
  let session = createCoordinatorReviewSession({
    reviewId: 'review-1',
    candidate,
    maxTurns: 3,
    now: 10,
  });

  assert.equal(getCoordinatorReviewChunk(session).id, 'chunk-1');
  assert.throws(() => completeCoordinatorReview(session), /incomplete review coverage/);
  session = submitCoordinatorChunkReview(session, {
    chunkId: 'chunk-1',
    chunkHash: '1'.repeat(64),
    verdict: 'passed',
    findings: [],
    reviewedAt: 11,
  });
  assert.equal(getCoordinatorReviewChunk(session).id, 'chunk-2');
  assert.throws(
    () => submitCoordinatorChunkReview(session, {
      chunkId: 'chunk-2',
      chunkHash: '2'.repeat(64),
      verdict: 'passed',
      findings: [],
      reviewedAt: 12,
    }),
    /requires explicit user confirmation/,
  );
  session = confirmCoordinatorReviewEvidence(session, {
    chunkId: 'chunk-2',
    chunkHash: '2'.repeat(64),
    decisionId: 'user-decision-1',
    confirmedAt: 13,
  });
  const completed = completeCoordinatorReview(session, 14);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.coverage.reviewedChunks, 2);
  assert.equal(completed.reviewHash.length, 64);
});

test('blocking finding creates rework and a changed candidate invalidates old coverage', () => {
  const baseCandidate = JSON.parse(readFileSync(
    new URL('./fixtures/coordinator-review-candidate.json', import.meta.url),
    'utf8',
  ));
  let session = createCoordinatorReviewSession({
    reviewId: 'review-2',
    candidate: baseCandidate,
    maxTurns: 3,
    now: 1,
  });
  session = submitCoordinatorChunkReview(session, {
    chunkId: baseCandidate.manifest.chunks[0].id,
    chunkHash: baseCandidate.manifest.chunks[0].hash,
    verdict: 'blocking',
    findings: [{ code: 'unsafe-change', message: 'unsafe change', blocking: true }],
    reviewedAt: 2,
  });
  assert.equal(session.status, 'rework-requested');
  assert.equal(session.rework?.findings[0].code, 'unsafe-change');

  const replacement = structuredClone(baseCandidate);
  replacement.id = 'candidate-replacement';
  replacement.diffHash = '9'.repeat(64);
  replacement.manifest.diffHash = replacement.diffHash;
  replacement.manifest.chunks[0].hash = '8'.repeat(64);
  const replaced = replaceCoordinatorReviewCandidate(session, replacement, 3);
  assert.equal(replaced.status, 'active');
  assert.equal(replaced.reviews.length, 0);
  assert.equal(replaced.cursor, 0);
});
