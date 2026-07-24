import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitDeliveryIntegrator } from '../dist-electron/delivery-integrator.js';
import { IntegrationQueue } from '../dist-electron/integration-queue.js';
import { buildDeliveryDiffManifest } from '../dist-electron/delivery-diff.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-integration-'));
  const base = join(root, 'base');
  mkdirSync(base);
  git(base, ['init']);
  git(base, ['config', 'user.email', 'test@example.com']);
  git(base, ['config', 'user.name', 'AhaStation Test']);
  writeFileSync(join(base, 'README.md'), '# Base\n');
  git(base, ['add', '--', 'README.md']);
  git(base, ['commit', '-m', 'base']);
  return { root, base, revision: git(base, ['rev-parse', 'HEAD']) };
}

async function candidate(repo, id, path, content, options = {}) {
  const workspace = join(repo.root, `task-${id}`);
  git(repo.base, ['worktree', 'add', '-b', `task-${id}`, workspace, repo.revision]);
  const absolute = join(workspace, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  const deliveryId = `delivery-${id}`;
  const taskId = `task-${id}`;
  const reviewHash = options.reviewHash ?? id.padEnd(64, 'a').slice(0, 64);
  const report = {
    status: 'completed',
    summary: `task ${id}`,
    files: [{ path, action: 'created' }],
    tests: [],
    unresolved: [],
  };
  const verification = { passed: true, checks: [] };
  const reportHash = sha256(stableStringify(report));
  const verificationHash = sha256(stableStringify(verification));
  git(workspace, ['add', '--', path]);
  git(workspace, ['commit', '-m', [
    `candidate ${id}`,
    '',
    `AhaStation-Delivery-Id: ${deliveryId}`,
    'AhaStation-Attempt: 1',
    `AhaStation-Report-Hash: ${reportHash}`,
    `AhaStation-Verification-Hash: ${verificationHash}`,
  ].join('\n')]);
  const commit = git(workspace, ['rev-parse', 'HEAD']);
  const tree = git(workspace, ['rev-parse', 'HEAD^{tree}']);
  const manifest = await buildDeliveryDiffManifest({
    workspace,
    baseRevision: repo.revision,
    candidateRevision: commit,
    paths: [path],
  });
  const candidateId = `candidate-${id}`;
  return {
    view: {
      id: deliveryId,
      meetingId: 'meeting-a',
      status: 'integrating',
      spec: { version: 1, taskId, objective: `task ${id}`, acceptanceCriteria: [] },
      sourceRevision: repo.revision,
      workspace,
      attempt: 1,
      attempts: [],
      updatedAt: 1,
    },
    deliveryCandidate: {
      id: candidateId,
      attempt: 1,
      report,
      verification,
      review: { passed: true, findings: [] },
      frozen: {
        schemaVersion: 1,
        id: candidateId,
        deliveryId,
        taskId,
        attempt: 1,
        workspace,
        baseRevision: repo.revision,
        commit,
        tree,
        reportHash,
        verificationHash,
        diffHash: manifest.diffHash,
        reportedPaths: [path],
        createdAt: 1,
        manifest,
      },
      reviewSession: { id: `review-${id}`, reviewHash },
    },
  };
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function queue(repo, options = {}) {
  const events = [];
  const integrator = new GitDeliveryIntegrator(
    repo.base,
    'meeting-a',
    join(repo.root, 'integration-worktrees'),
  );
  const instance = new IntegrationQueue({
    meetingId: 'meeting-a',
    expectedUserBaseRevision: repo.revision,
    integrator,
    verify: options.verify ?? (async () => ({ passed: true, checks: [{ status: 'passed' }] })),
    async append(type, payload) {
      events.push({ type, payload });
      if (options.append) await options.append(type, payload);
    },
    async flush() { events.push({ type: 'flush' }); },
  });
  return { instance, events, integrator };
}

test('parallel candidates serialize onto one Meeting branch without moving the user base', async () => {
  const repo = repository();
  const first = await candidate(repo, 'one', 'src/one.ts', 'export const one = 1;\n');
  const second = await candidate(repo, 'two', 'src/two.ts', 'export const two = 2;\n');
  const { instance, events } = queue(repo);

  const [one, two] = await Promise.all([
    instance.enqueue(first.view, first.deliveryCandidate),
    instance.enqueue(second.view, second.deliveryCandidate),
  ]);
  const state = await instance.inspectState();

  assert.equal(one.kind, 'meeting-branch');
  assert.equal(two.sourceRevision, one.resultRevision);
  assert.equal(state.durableHead, two.resultRevision);
  assert.equal(git(repo.base, ['rev-parse', 'HEAD']), repo.revision);
  assert.equal(readFileSync(join(state.workspace, 'src/one.ts'), 'utf8').trim(), 'export const one = 1;');
  assert.equal(readFileSync(join(state.workspace, 'src/two.ts'), 'utf8').trim(), 'export const two = 2;');
  const accepted = events.filter((event) => event.type === 'integration-accepted');
  assert.equal(accepted.length, 2);
  assert.equal(events.at(-1).type, 'flush');
});

test('post-integration verification failure restores the prior queue head', async () => {
  const repo = repository();
  const change = await candidate(repo, 'bad', 'src/bad.ts', 'export const bad = true;\n');
  const { instance } = queue(repo, {
    verify: async () => ({ passed: false, checks: [], error: 'integration test failed' }),
  });
  const before = (await instance.inspectState()).durableHead;

  await assert.rejects(
    instance.enqueue(change.view, change.deliveryCandidate),
    /integration test failed/,
  );

  const state = await instance.inspectState();
  assert.equal(state.durableHead, before);
  assert.equal(git(state.workspace, ['rev-parse', 'HEAD']), before);
  assert.equal(git(repo.base, ['rev-parse', 'HEAD']), repo.revision);
});

test('cherry-pick conflict aborts only the queue-owned operation', async () => {
  const repo = repository();
  const first = await candidate(repo, 'left', 'README.md', '# Left\n');
  const second = await candidate(repo, 'right', 'README.md', '# Right\n');
  const { instance } = queue(repo);
  await instance.enqueue(first.view, first.deliveryCandidate);
  const acceptedHead = (await instance.inspectState()).durableHead;

  await assert.rejects(
    instance.enqueue(second.view, second.deliveryCandidate),
    /conflicts with Meeting integration head/,
  );

  const state = await instance.inspectState();
  assert.equal(state.durableHead, acceptedHead);
  assert.equal(git(state.workspace, ['rev-parse', 'HEAD']), acceptedHead);
  assert.equal(git(repo.base, ['rev-parse', 'HEAD']), repo.revision);
  assert.equal(git(second.view.workspace, ['rev-parse', 'HEAD']), second.deliveryCandidate.frozen.commit);
});

test('restart detects and resolves only a queue-owned in-progress cherry-pick', async () => {
  const repo = repository();
  const first = await candidate(repo, 'recovery-left', 'README.md', '# Left\n');
  const second = await candidate(repo, 'recovery-right', 'README.md', '# Right\n');
  const initial = queue(repo);
  await initial.instance.enqueue(first.view, first.deliveryCandidate);
  const integrationState = await initial.instance.inspectState();
  assert.throws(
    () => git(integrationState.workspace, ['cherry-pick', second.deliveryCandidate.frozen.commit]),
  );
  assert.equal(
    git(integrationState.workspace, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD']),
    second.deliveryCandidate.frozen.commit,
  );

  const restarted = queue(repo);
  restarted.instance.restore([{
    id: 'evt-staging-conflict',
    seq: 1,
    ts: 1,
    meetingId: 'meeting-a',
    type: 'integration-staging',
    payload: {
      schemaVersion: 1,
      taskId: second.view.spec.taskId,
      attempt: 1,
      data: {
        schemaVersion: 1,
        taskId: second.view.spec.taskId,
        deliveryId: second.view.id,
        attempt: 1,
        data: { integrationHead: integrationState.durableHead },
      },
    },
  }]);
  const interrupted = await restarted.instance.detectInterruptedOperation();
  assert.ok(interrupted);
  assert.equal(interrupted.workspace, integrationState.workspace);
  assert.equal(
    restarted.instance.snapshot().activeTaskId,
    second.view.spec.taskId,
  );
  assert.deepEqual(
    await restarted.instance.resolveInterruptedOperation('unrelated-task'),
    { ok: false, error: 'interrupted integration task does not match' },
  );
  assert.deepEqual(
    await restarted.instance.resolveInterruptedOperation(second.view.spec.taskId),
    { ok: true },
  );
  assert.equal(
    git(integrationState.workspace, ['rev-parse', 'HEAD']),
    integrationState.durableHead,
  );
  assert.equal(git(repo.base, ['rev-parse', 'HEAD']), repo.revision);
});

test('a staged integration is recovered idempotently after restart', async () => {
  const repo = repository();
  const change = await candidate(repo, 'resume', 'src/resume.ts', 'export const resumed = true;\n');
  const first = queue(repo);
  const state = await first.instance.inspectState();
  const staged = await first.integrator.stageCandidate(
    change.view,
    change.deliveryCandidate,
    state,
  );

  const restarted = queue(repo);
  restarted.instance.restore([{
    id: 'evt-staged',
    seq: 1,
    ts: 1,
    meetingId: 'meeting-a',
    type: 'integration-staged',
    payload: {
      schemaVersion: 1,
      taskId: change.view.spec.taskId,
      attempt: 1,
      data: {
        schemaVersion: 1,
        taskId: change.view.spec.taskId,
        deliveryId: change.view.id,
        attempt: 1,
        candidateId: change.deliveryCandidate.id,
        candidateCommit: change.deliveryCandidate.frozen.commit,
        reviewHash: change.deliveryCandidate.reviewSession.reviewHash,
        data: { staged },
      },
    },
  }]);
  const integrated = await restarted.instance.enqueue(change.view, change.deliveryCandidate);
  const recoveredState = await restarted.instance.inspectState();

  assert.equal(integrated.sourceRevision, repo.revision);
  assert.equal(recoveredState.durableHead, integrated.resultRevision);
  assert.equal(
    git(recoveredState.workspace, ['rev-list', '--count', `${repo.revision}..HEAD`]),
    '1',
    'the reviewed candidate must not be cherry-picked twice',
  );
  assert.equal(git(repo.base, ['rev-parse', 'HEAD']), repo.revision);
});

test('durable accepted facts restore duplicate enqueue without another integration', async () => {
  const repo = repository();
  const change = await candidate(repo, 'accepted', 'src/accepted.ts', 'export const accepted = true;\n');
  const first = queue(repo);
  const integrated = await first.instance.enqueue(change.view, change.deliveryCandidate);
  const acceptedEvent = first.events.find((event) => event.type === 'integration-accepted');
  assert.ok(acceptedEvent);

  const restarted = queue(repo);
  restarted.instance.restore([{
    id: 'evt-accepted',
    seq: 1,
    ts: 1,
    meetingId: 'meeting-a',
    type: 'integration-accepted',
    payload: {
      schemaVersion: 1,
      taskId: change.view.spec.taskId,
      attempt: 1,
      data: acceptedEvent.payload,
    },
  }]);
  const duplicate = await restarted.instance.enqueue(change.view, change.deliveryCandidate);

  assert.deepEqual(duplicate, integrated);
  assert.equal(restarted.events.length, 0);
  assert.equal(restarted.instance.currentHead(), integrated.resultRevision);
});

test('failed durable acceptance restores the prior queue head', async () => {
  const repo = repository();
  const change = await candidate(repo, 'flush', 'src/flush.ts', 'export const flush = true;\n');
  let rejected = false;
  const { instance } = queue(repo, {
    async append(type) {
      if (type === 'integration-accepted' && !rejected) {
        rejected = true;
        throw new Error('journal unavailable');
      }
    },
  });
  const prior = (await instance.inspectState()).durableHead;

  await assert.rejects(instance.enqueue(change.view, change.deliveryCandidate), /journal unavailable/);

  const state = await instance.inspectState();
  assert.equal(state.durableHead, prior);
  assert.equal(instance.currentHead(), prior);
  assert.equal(git(state.workspace, ['rev-parse', 'HEAD']), prior);
});

test('candidate report and verification hashes are rechecked before integration', async () => {
  const repo = repository();
  const change = await candidate(repo, 'tamper', 'src/tamper.ts', 'export const tamper = true;\n');
  change.deliveryCandidate.report.summary = 'changed after review';
  const { instance } = queue(repo);

  await assert.rejects(
    instance.enqueue(change.view, change.deliveryCandidate),
    /evidence hashes no longer match/,
  );
  assert.equal(git(repo.base, ['rev-parse', 'HEAD']), repo.revision);
});
