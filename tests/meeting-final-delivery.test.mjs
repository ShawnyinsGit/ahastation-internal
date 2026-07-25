import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildMeetingDelivery,
  MeetingDeliveryNotReadyError,
  publishedMeetingDelivery,
} from '../dist-electron/meeting-delivery.js';
import {
  GitDeliveryIntegrator,
  PublicationPausedError,
} from '../dist-electron/delivery-integrator.js';
import { IntegrationQueue } from '../dist-electron/integration-queue.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';

const sha = (char) => char.repeat(40);
const hash = (char) => char.repeat(64);

function acceptedTask(overrides = {}) {
  const taskId = overrides.id ?? 'task-login';
  const integrationHead = overrides.integrationHead ?? sha('b');
  return {
    id: taskId,
    title: overrides.title ?? 'Login validation',
    status: overrides.status ?? 'accepted',
    attempt: 1,
    approvedPlanVersion: 2,
    approvalDecisionId: 'decision-login',
    required: overrides.required,
    delivery: {
      id: 'delivery-login',
      meetingId: 'meeting-a',
      status: overrides.deliveryStatus ?? 'accepted',
      spec: {
        version: 1,
        taskId,
        objective: 'fix login',
        acceptanceCriteria: [],
      },
      sourceRevision: sha('a'),
      workspace: '/not/serialized',
      attempt: 1,
      attempts: [],
      candidate: {
        id: 'candidate-login',
        attempt: 1,
        report: {
          status: 'completed',
          summary: 'Bearer secret-value-123456789 was removed',
          files: [{ path: 'src/login.ts', action: 'modified' }],
          tests: [],
          unresolved: [{
            code: 'limit',
            message: 'api_key=secret-value-123456789 is not included',
            blocking: false,
          }],
        },
        verification: {
          passed: true,
          checks: [{ status: 'passed', summary: '42 tests passed' }],
        },
        review: {
          passed: true,
          findings: [{ code: 'reviewed', message: 'complete', blocking: false }],
        },
        frozen: {
          schemaVersion: 1,
          id: 'candidate-login',
          deliveryId: 'delivery-login',
          taskId,
          attempt: 1,
          workspace: '/not/serialized',
          baseRevision: sha('a'),
          commit: sha('c'),
          tree: sha('d'),
          reportHash: hash('e'),
          verificationHash: hash('f'),
          diffHash: hash('1'),
          reportedPaths: ['src/login.ts'],
          createdAt: 1,
          manifest: {
            schemaVersion: 1,
            baseRevision: sha('a'),
            candidateRevision: sha('c'),
            diffHash: hash('1'),
            files: [{
              path: 'src/login.ts',
              status: 'modified',
              additions: 2,
              deletions: 1,
              oldMode: '100644',
              newMode: '100644',
              kind: 'text',
              chunkIds: ['chunk-1'],
              requiresUserConfirmation: false,
            }],
            chunks: [],
            totalAdditions: 2,
            totalDeletions: 1,
          },
        },
        reviewSession: {
          id: 'review-login',
          reviewHash: hash('2'),
        },
      },
      integration: {
        kind: 'meeting-branch',
        sourceRevision: sha('a'),
        resultRevision: integrationHead,
        candidateCommit: sha('c'),
        reviewHash: hash('2'),
      },
      updatedAt: 1,
    },
  };
}

test('final delivery requires every required task to be reviewed and integrated', () => {
  assert.throws(() => buildMeetingDelivery({
    meetingId: 'meeting-a',
    planVersion: 2,
    tasks: [acceptedTask(), { id: 'task-docs', title: 'Docs', status: 'reviewing' }],
    integrationHead: sha('b'),
    expectedUserBaseRevision: sha('a'),
  }), MeetingDeliveryNotReadyError);

  assert.throws(() => buildMeetingDelivery({
    meetingId: 'meeting-a',
    planVersion: 2,
    tasks: [acceptedTask({ deliveryStatus: 'integration-conflict' })],
    integrationHead: sha('b'),
    expectedUserBaseRevision: sha('a'),
  }), /durable delivery evidence/);
});

test('final delivery is deterministic, bounded, and excludes native or credential payloads', () => {
  const input = {
    meetingId: 'meeting-a',
    planVersion: 2,
    tasks: [
      acceptedTask(),
      {
        id: 'optional-cancelled',
        title: 'Optional follow-up',
        status: 'cancelled',
        required: false,
      },
    ],
    integrationHead: sha('b'),
    expectedUserBaseRevision: sha('a'),
  };
  const first = buildMeetingDelivery(input);
  const second = buildMeetingDelivery(structuredClone(input));
  const serialized = JSON.stringify(first);

  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.id, second.id);
  assert.equal(first.tasks.length, 1);
  assert.equal(first.changedFiles[0].path, 'src/login.ts');
  assert.equal(first.unresolvedWork[0].taskId, 'optional-cancelled');
  assert.doesNotMatch(serialized, /secret-value-123456789/);
  assert.doesNotMatch(serialized, /not\/serialized/);
  assert.match(serialized, /\[REDACTED\]/);
});

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-publish-'));
  const base = join(root, 'base');
  execFileSync('git', ['init', base]);
  git(base, ['config', 'user.email', 'test@example.com']);
  git(base, ['config', 'user.name', 'AhaStation Test']);
  writeFileSync(join(base, 'README.md'), '# Base\n');
  git(base, ['add', '--', 'README.md']);
  git(base, ['commit', '-m', 'base']);
  return { root, base, revision: git(base, ['rev-parse', 'HEAD']) };
}

async function publicationFixture(repo) {
  const events = [];
  const integrator = new GitDeliveryIntegrator(
    repo.base,
    'meeting-publish',
    join(repo.root, 'integration-worktrees'),
  );
  const state = await integrator.initialize(repo.revision);
  writeFileSync(join(state.workspace, 'result.txt'), 'integrated\n');
  git(state.workspace, ['add', '--', 'result.txt']);
  git(state.workspace, ['commit', '-m', 'integrated task']);
  const integrationHead = git(state.workspace, ['rev-parse', 'HEAD']);
  const queue = new IntegrationQueue({
    meetingId: 'meeting-publish',
    expectedUserBaseRevision: repo.revision,
    integrator,
    verify: async () => ({ passed: true, checks: [] }),
    async append(type, payload) { events.push({ type, payload }); },
    async flush() { events.push({ type: 'flush' }); },
  });
  queue.restore([{
    id: 'accepted',
    seq: 1,
    ts: 1,
    meetingId: 'meeting-publish',
    type: 'integration-accepted',
    payload: {
      schemaVersion: 1,
      taskId: 'task-a',
      attempt: 1,
      data: {
        schemaVersion: 1,
        taskId: 'task-a',
        deliveryId: 'delivery-a',
        attempt: 1,
        candidateId: 'candidate-a',
        candidateCommit: git(state.workspace, ['rev-parse', 'HEAD^']),
        reviewHash: hash('3'),
        data: {
          durableHead: integrationHead,
          integration: {
            kind: 'meeting-branch',
            sourceRevision: repo.revision,
            resultRevision: integrationHead,
            workspace: state.workspace,
            branch: state.branch,
          },
        },
      },
    },
  }]);
  return { queue, events, integrationHead };
}

test('final publication fast-forwards the exact verified Meeting head once', async () => {
  const repo = repository();
  const fixture = await publicationFixture(repo);
  const request = {
    deliveryId: 'meeting-delivery-a',
    contentHash: hash('4'),
    integrationHead: fixture.integrationHead,
    expectedUserBaseRevision: repo.revision,
  };
  const published = await fixture.queue.publishFinalDelivery(request);
  const replayed = await fixture.queue.publishFinalDelivery(request);

  assert.equal(git(repo.base, ['rev-parse', 'HEAD']), fixture.integrationHead);
  assert.equal(published.alreadyPublished, false);
  assert.equal(replayed.alreadyPublished, true);
  assert.equal(fixture.events.filter((event) => event.type === 'meeting-publication-completed').length, 2);
});

test('dirty or moved user bases pause publication without mutation', async () => {
  const dirtyRepo = repository();
  const dirty = await publicationFixture(dirtyRepo);
  writeFileSync(join(dirtyRepo.base, 'dirty.txt'), 'user work\n');
  await assert.rejects(dirty.queue.publishFinalDelivery({
    deliveryId: 'meeting-delivery-dirty',
    contentHash: hash('5'),
    integrationHead: dirty.integrationHead,
    expectedUserBaseRevision: dirtyRepo.revision,
  }), PublicationPausedError);
  assert.equal(git(dirtyRepo.base, ['rev-parse', 'HEAD']), dirtyRepo.revision);

  const movedRepo = repository();
  const moved = await publicationFixture(movedRepo);
  writeFileSync(join(movedRepo.base, 'user.txt'), 'user commit\n');
  git(movedRepo.base, ['add', '--', 'user.txt']);
  git(movedRepo.base, ['commit', '-m', 'user moved base']);
  const movedHead = git(movedRepo.base, ['rev-parse', 'HEAD']);
  await assert.rejects(moved.queue.publishFinalDelivery({
    deliveryId: 'meeting-delivery-moved',
    contentHash: hash('6'),
    integrationHead: moved.integrationHead,
    expectedUserBaseRevision: movedRepo.revision,
  }), PublicationPausedError);
  assert.equal(git(movedRepo.base, ['rev-parse', 'HEAD']), movedHead);
});

test('Orchestrator persists final readiness before notifying the renderer', async () => {
  const order = [];
  const task = acceptedTask();
  const fake = {
    finalDeliveryBuild: undefined,
    finalMeetingDelivery: null,
    finalMeetingDecision: null,
    meetingId: 'meeting-a',
    expectedUserBaseRevision: sha('a'),
    meetingScheduler: {
      snapshot: () => [task],
      getPlanVersion: () => 2,
    },
    integrationQueue: {
      inspectState: async () => ({
        schemaVersion: 1,
        meetingId: 'meeting-a',
        expectedUserBaseRevision: sha('a'),
        durableHead: sha('b'),
        workspace: '/final-integration',
        branch: 'ahastation/integration/meeting-a',
      }),
    },
    deliveryVerifier: {
      verify: async (orderInput) => {
        assert.equal(orderInput.workspace, '/final-integration');
        assert.equal(orderInput.sourceRevision, sha('b'));
        return { passed: true, checks: [{ summary: 'full Meeting checks passed' }] };
      },
    },
    repository: {
      async append(type) { order.push(type); },
      async flush() { order.push('flush'); },
    },
    safeEmit(event) {
      order.push(`emit:${event.event.kind}`);
    },
    async snapshotActiveMeeting() {
      order.push('snapshot');
    },
    buildFinalMeetingDelivery: Orchestrator.prototype.buildFinalMeetingDelivery,
  };

  const delivery = await Orchestrator.prototype.prepareFinalMeetingDelivery.call(fake);
  assert.ok(delivery);
  assert.equal(delivery.meetingVerification.integrationHead, sha('b'));
  assert.ok(order.indexOf('meeting-delivery-ready') < order.indexOf('flush'));
  assert.ok(order.indexOf('flush') < order.indexOf('emit:meeting-delivery-updated'));
});

test('final acceptance journals intent before exact publication and acceptance after it', async () => {
  const delivery = buildMeetingDelivery({
    meetingId: 'meeting-a',
    planVersion: 2,
    tasks: [acceptedTask()],
    integrationHead: sha('b'),
    expectedUserBaseRevision: sha('a'),
  });
  const order = [];
  const fake = {
    finalMeetingDelivery: delivery,
    finalMeetingDecision: null,
    requireCurrentMeetingDelivery: async () => delivery,
    repository: {
      async append(type) { order.push(type); },
      async flush() { order.push('flush'); },
    },
    integrationQueue: {
      async publishFinalDelivery(request) {
        order.push('publish');
        assert.equal(request.integrationHead, delivery.integrationHead);
        return {
          schemaVersion: 1,
          expectedUserBaseRevision: delivery.expectedUserBaseRevision,
          integrationHead: delivery.integrationHead,
          publishedHead: delivery.integrationHead,
          alreadyPublished: false,
        };
      },
      async cleanupPublishedIntegration() { order.push('cleanup'); },
    },
    safeEmit() { order.push('emit'); },
    async snapshotActiveMeeting() { order.push('snapshot'); },
  };

  const published = await Orchestrator.prototype.acceptMeetingDelivery.call(
    fake,
    delivery.id,
    delivery.contentHash,
  );
  assert.equal(published.publicationState, 'published');
  assert.ok(order.indexOf('meeting-delivery-accept-intent') < order.indexOf('publish'));
  assert.ok(order.indexOf('publish') < order.indexOf('meeting-delivery-accepted'));
  assert.ok(order.indexOf('meeting-delivery-accepted') < order.indexOf('cleanup'));
});

test('final rework creates versioned replacements and never mutates accepted evidence', async () => {
  const delivery = buildMeetingDelivery({
    meetingId: 'meeting-a',
    planVersion: 2,
    tasks: [acceptedTask()],
    integrationHead: sha('b'),
    expectedUserBaseRevision: sha('a'),
  });
  const original = structuredClone(delivery);
  const events = [];
  const fake = {
    finalMeetingDelivery: delivery,
    finalMeetingDecision: null,
    requireCurrentMeetingDelivery: async () => delivery,
    repository: {
      async append(type, payload) { events.push({ type, payload }); },
      async flush() {},
    },
    meetingScheduler: {
      createFinalDeliveryRework(reason, contentHash) {
        assert.equal(reason, '补充错误状态测试');
        assert.equal(contentHash, delivery.contentHash);
        return { planVersion: 3, taskIds: ['task-login-rework-v3'] };
      },
    },
    safeEmit() {},
    async snapshotActiveMeeting() {},
  };

  const result = await Orchestrator.prototype.requestMeetingDeliveryRework.call(
    fake,
    delivery.id,
    delivery.contentHash,
    '补充错误状态测试',
  );
  assert.deepEqual(result, { planVersion: 3, taskIds: ['task-login-rework-v3'] });
  assert.deepEqual(delivery, original);
  assert.equal(events.at(-1).type, 'meeting-delivery-rework-created');
  assert.equal(events.at(-1).payload.operations[0].kind, 'add-rework-task');
  assert.equal(events.at(-1).payload.operations[0].supersedesTaskId, 'task-login');
});

test('final delivery and decision recover exactly and duplicate acceptance is idempotent', async () => {
  const ready = buildMeetingDelivery({
    meetingId: 'meeting-a',
    planVersion: 2,
    tasks: [acceptedTask()],
    integrationHead: sha('b'),
    expectedUserBaseRevision: sha('a'),
  });
  const published = publishedMeetingDelivery(ready);
  const decision = {
    kind: 'accept',
    deliveryId: ready.id,
    contentHash: ready.contentHash,
    integrationHead: ready.integrationHead,
    decidedAt: 123,
  };
  const restored = {
    finalMeetingDelivery: null,
    finalMeetingDecision: null,
  };
  Orchestrator.prototype.restoreFinalMeetingDelivery.call(restored, [
    { type: 'meeting-delivery-ready', payload: { delivery: ready } },
    { type: 'meeting-delivery-accepted', payload: { delivery: published, decision } },
  ]);
  assert.deepEqual(restored.finalMeetingDelivery, published);
  assert.deepEqual(restored.finalMeetingDecision, decision);

  let publications = 0;
  const fake = {
    finalMeetingDelivery: published,
    finalMeetingDecision: decision,
    requireCurrentMeetingDelivery: async () => published,
    integrationQueue: {
      async publishFinalDelivery() { publications += 1; throw new Error('must not republish'); },
    },
  };
  const duplicate = await Orchestrator.prototype.acceptMeetingDelivery.call(
    fake,
    ready.id,
    ready.contentHash,
  );
  assert.deepEqual(duplicate, published);
  assert.equal(publications, 0);
});

test('crash after publication completes the durable accept intent only with exact evidence', async () => {
  const ready = buildMeetingDelivery({
    meetingId: 'meeting-a',
    planVersion: 2,
    tasks: [acceptedTask()],
    integrationHead: sha('b'),
    expectedUserBaseRevision: sha('a'),
  });
  const publication = {
    schemaVersion: 1,
    expectedUserBaseRevision: ready.expectedUserBaseRevision,
    integrationHead: ready.integrationHead,
    publishedHead: ready.integrationHead,
    alreadyPublished: true,
  };
  const appended = [];
  const fake = {
    finalMeetingDelivery: ready,
    finalMeetingDecision: null,
    integrationQueue: {
      snapshot() {
        return {
          publicationState: 'published',
          publicationRequest: {
            deliveryId: ready.id,
            contentHash: ready.contentHash,
            integrationHead: ready.integrationHead,
            expectedUserBaseRevision: ready.expectedUserBaseRevision,
          },
          publication,
        };
      },
      async cleanupPublishedIntegration(head) {
        assert.equal(head, ready.integrationHead);
      },
    },
    repository: {
      async append(type, payload) { appended.push({ type, payload }); },
      async flush() {},
    },
    async snapshotActiveMeeting() {},
  };
  const intent = {
    id: 'intent',
    seq: 8,
    ts: 100,
    meetingId: 'meeting-a',
    type: 'meeting-delivery-accept-intent',
    payload: {
      schemaVersion: 1,
      deliveryId: ready.id,
      contentHash: ready.contentHash,
      integrationHead: ready.integrationHead,
      decidedAt: 99,
    },
  };
  await Orchestrator.prototype.reconcileInterruptedFinalAcceptance.call(fake, [intent]);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, 'meeting-delivery-accepted');
  assert.equal(appended[0].payload.recoveredFromAcceptIntentSeq, 8);
  assert.equal(fake.finalMeetingDecision.decidedAt, 99);
  assert.equal(fake.finalMeetingDelivery.publicationState, 'published');

  const mismatched = {
    ...fake,
    finalMeetingDelivery: ready,
    finalMeetingDecision: null,
    repository: {
      async append() { assert.fail('mismatched evidence must not complete acceptance'); },
      async flush() {},
    },
    integrationQueue: {
      ...fake.integrationQueue,
      snapshot() {
        return {
          ...fake.integrationQueue.snapshot(),
          publicationRequest: {
            ...fake.integrationQueue.snapshot().publicationRequest,
            contentHash: sha('different'),
          },
        };
      },
    },
  };
  await Orchestrator.prototype.reconcileInterruptedFinalAcceptance.call(mismatched, [intent]);
  assert.equal(mismatched.finalMeetingDecision, null);
});
