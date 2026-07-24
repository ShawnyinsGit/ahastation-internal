import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { TaskMailbox } from '../dist-electron/task-mailbox.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-mailbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const meetingRoot = join(root, 'meeting');
  const repository = new MeetingRepository('meeting', 0, { rootDir: meetingRoot });
  return { root, meetingRoot, repository };
}

function message(overrides = {}) {
  return {
    id: 'message-1',
    taskId: 'task-a',
    attempt: 1,
    sender: 'coordinator',
    kind: 'instruction',
    payload: { text: 'inspect the login flow' },
    ...overrides,
  };
}

test('enqueue is durable before delivery callback and Meeting sequence stays separate', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const observations = [];
  const mailbox = new TaskMailbox(repository, {
    async onDurableEnqueue(taskMessage) {
      const journal = await readFile(join(meetingRoot, 'events.jsonl'), 'utf8');
      observations.push({
        taskSeq: taskMessage.seq,
        journal: journal.trim(),
      });
    },
  });

  const first = await mailbox.enqueue(message());
  const second = await mailbox.enqueue(message({
    id: 'message-2',
    attempt: 2,
    payload: { text: 'continue after rework' },
  }));
  const other = await mailbox.enqueue(message({
    id: 'message-other',
    taskId: 'task-b',
    payload: { text: 'independent task' },
  }));

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(other.seq, 1);
  assert.equal(observations.length, 3);
  assert.match(observations[0].journal, /task-message-enqueued/);
  const meetingEvents = await MeetingRepository.replay('meeting', meetingRoot);
  assert.deepEqual(meetingEvents.map((event) => event.seq), [1, 2, 3]);
  assert.equal(other.seq, 1);
  assert.equal(meetingEvents[2].seq, 3);
  assert.match(meetingEvents[0].id, /^[0-9a-f-]{36}$/i);
});

test('duplicate IDs are idempotent but semantic conflicts fail', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const mailbox = new TaskMailbox(repository);

  const first = await mailbox.enqueue(message({
    payload: { text: 'inspect the login flow', options: { alpha: 1, beta: 2 } },
  }));
  const duplicate = await mailbox.enqueue(message({
    payload: { options: { beta: 2, alpha: 1 }, text: 'inspect the login flow' },
  }));

  assert.deepEqual(duplicate, first);
  assert.equal((await MeetingRepository.replay('meeting', meetingRoot)).length, 1);
  await assert.rejects(
    mailbox.enqueue(message({ payload: { text: 'different instruction' } })),
    /different semantics/,
  );
});

test('delivery and acknowledgement are separate monotonic durable events', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const mailbox = new TaskMailbox(repository);
  await mailbox.enqueue(message());
  assert.equal((await mailbox.markDelivered('task-a', 'message-1')).status, 'delivered');
  assert.equal((await mailbox.acknowledge('task-a', 'message-1')).status, 'acknowledged');
  assert.equal((await mailbox.acknowledge('task-a', 'message-1')).status, 'acknowledged');
  await assert.rejects(
    mailbox.markFailed('task-a', 'message-1'),
    /cannot fail/,
  );

  const events = await MeetingRepository.replay('meeting', meetingRoot);
  assert.deepEqual(events.map((event) => event.type), [
    'task-message-enqueued',
    'task-message-delivered',
    'task-message-acknowledged',
  ]);
});

test('restore preserves order and retries delivered-but-unacknowledged messages', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const mailbox = new TaskMailbox(repository);
  await mailbox.enqueue(message());
  await mailbox.markDelivered('task-a', 'message-1');
  await mailbox.enqueue(message({ id: 'message-2', payload: { text: 'second' } }));
  await mailbox.markDelivered('task-a', 'message-2');
  await mailbox.acknowledge('task-a', 'message-2');

  const restored = new TaskMailbox(repository);
  restored.restore(await MeetingRepository.replay('meeting', meetingRoot));

  assert.deepEqual(
    restored.list('task-a').map((entry) => [entry.seq, entry.status]),
    [[1, 'queued'], [2, 'acknowledged']],
  );
  assert.equal(
    (await restored.enqueue(message({
      id: 'message-3',
      attempt: 3,
      payload: { text: 'next attempt' },
    }))).seq,
    3,
  );
});

test('failed delivery can retry without another semantic instruction', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const mailbox = new TaskMailbox(repository);
  await mailbox.enqueue(message());
  assert.equal((await mailbox.markFailed('task-a', 'message-1')).status, 'failed');
  assert.equal((await mailbox.markDelivered('task-a', 'message-1')).status, 'delivered');
  const events = await MeetingRepository.replay('meeting', meetingRoot);
  assert.equal(events.filter((event) => event.type === 'task-message-enqueued').length, 1);
});

test('terminal attempts require a new attempt for follow-up', async (t) => {
  const { repository } = await fixture(t);
  const mailbox = new TaskMailbox(repository, {
    getTaskLifecycle() {
      return { currentAttempt: 2, terminal: true };
    },
  });

  await assert.rejects(
    mailbox.enqueue(message({ kind: 'follow-up', attempt: 2 })),
    /requires a new attempt/,
  );
  assert.equal(
    (await mailbox.enqueue(message({ kind: 'follow-up', attempt: 3 }))).attempt,
    3,
  );
});

test('native Backend payloads and credentials never enter mailbox events', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const mailbox = new TaskMailbox(repository);

  await assert.rejects(
    mailbox.enqueue(message({ payload: { nativePayload: { token: 'secret' } } })),
    /forbidden native field/,
  );
  await assert.rejects(
    mailbox.enqueue(message({ payload: { authorization: 'Bearer secret' } })),
    /forbidden native field|forbidden key/,
  );
  await assert.rejects(readFile(join(meetingRoot, 'events.jsonl'), 'utf8'));
});

test('paginated replay normalizes historical IDs and clamps page size', async (t) => {
  const { meetingRoot } = await fixture(t);
  await mkdir(meetingRoot, { recursive: true });
  await writeFile(join(meetingRoot, 'events.jsonl'), [
    JSON.stringify({ seq: 1, ts: 1, meetingId: 'meeting', type: 'old', payload: {} }),
    JSON.stringify({ seq: 2, ts: 2, meetingId: 'meeting', type: 'old', payload: {} }),
    '{"seq":3',
  ].join('\n'));

  const first = await MeetingRepository.replayAfter('meeting', 0, 1, meetingRoot);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].id, 'meeting:1');
  assert.equal(first.nextAfterSeq, 1);
  assert.equal(first.hasMore, true);
  const second = await MeetingRepository.replayAfter('meeting', first.nextAfterSeq, 999, meetingRoot);
  assert.deepEqual(second.events.map((event) => event.seq), [2]);
  assert.equal(second.hasMore, false);
});

test('journal write failure permanently faults later append and snapshot', async (t) => {
  const { root } = await fixture(t);
  const impossibleRoot = join(root, 'not-a-directory');
  await writeFile(impossibleRoot, 'file');
  const repository = new MeetingRepository('faulted', 0, { rootDir: impossibleRoot });

  await assert.rejects(repository.append('first', {}));
  assert.equal(repository.isWriteFaulted(), true);
  await assert.rejects(repository.append('second', {}));
  await assert.rejects(repository.snapshot({ status: 'active' }));
  await assert.rejects(repository.flush());
});

test('rebuildable snapshot validation failure does not fault the journal', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const invalid = {};
  invalid.self = invalid;

  await assert.rejects(repository.snapshot(invalid), /cycle/);
  assert.equal(repository.isWriteFaulted(), false);
  await repository.append('journal-remains-authoritative', { ok: true });
  assert.deepEqual(
    (await MeetingRepository.replay('meeting', meetingRoot)).map((event) => event.type),
    ['journal-remains-authoritative'],
  );
});

test('invalid later payload preserves an already queued durable predecessor', async (t) => {
  const { meetingRoot, repository } = await fixture(t);
  const first = repository.append('valid-first', { ok: true });
  const invalid = {};
  invalid.self = invalid;

  await assert.rejects(repository.append('invalid-second', invalid), /cycle/);
  const persisted = await first;
  assert.equal(persisted.seq, 1);
  assert.deepEqual(
    (await MeetingRepository.replay('meeting', meetingRoot)).map((event) => event.type),
    ['valid-first'],
  );
  await assert.rejects(repository.append('must-not-skip-gap', {}), /cycle/);
});
