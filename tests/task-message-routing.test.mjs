import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { TaskMailbox } from '../dist-electron/task-mailbox.js';
import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ahastation-routing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new MeetingRepository('meeting', 0, {
    rootDir: join(root, 'meeting'),
  });
  const mailbox = new TaskMailbox(repository);
  const sessions = [];
  const coordinatorInputs = [];
  const releases = [];
  const workspace = {
    kind: 'read-only',
    cwd: root,
    sourceRevision: 'test-revision',
    lockKeys: [],
    baseline: {
      kind: 'non-git',
      revision: 'test-revision',
      changedPaths: [],
      untrackedPaths: [],
      truncated: false,
    },
    managed: true,
  };
  const scheduler = new WorkerScheduler({
    emit() {},
    cwd: root,
    autoApproveScope: 'off',
    taskMailbox: mailbox,
    sessionFactory(opts) {
      const session = {
        opts,
        inputs: [],
        interruptReasons: [],
        async start() {},
        sendUserText(text) {
          this.inputs.push(text);
          options.onSendUserText?.(this, text);
        },
        sendUserContent() {},
        resolvePermission() {},
        async interrupt(reason) {
          this.interruptReasons.push(reason);
          await options.onInterrupt?.(this, reason, opts);
        },
        snapshot() {
          return {
            protocol: 'test-backend',
            sessionId: options.sessionId ?? 'session-checkpoint',
          };
        },
        end() {},
      };
      sessions.push(session);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() {
      return {
        sendUserText(text) { coordinatorInputs.push(text); },
      };
    },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    workspaceManager: options.workspaceManager ?? {
      inspectBaseline() { return workspace.baseline; },
      preparationBlock() { return null; },
      canPrepare() { return true; },
      prepare() { return workspace; },
      release(taskId, removeWorktree) { releases.push({ taskId, removeWorktree }); },
    },
  });
  return {
    root,
    repository,
    mailbox,
    scheduler,
    sessions,
    coordinatorInputs,
    releases,
    workspace,
  };
}

function install(scheduler, tasks = [{ id: 'task-a', title: 'Task A', prompt: 'work', deps: [] }]) {
  assert.deepEqual(scheduler.installPlan(tasks), { ok: true });
}

test('follow-ups remain FIFO and wait for provider turn completion', async (t) => {
  const { scheduler, sessions, mailbox } = await fixture(t);
  install(scheduler);
  await waitFor(() => sessions.length === 1, 'worker did not start');

  const first = await scheduler.queueFollowUp('task-a', 'first follow-up');
  const second = await scheduler.queueFollowUp('task-a', 'second follow-up');
  assert.equal(sessions[0].inputs.length, 1, 'follow-up must not interrupt or enter the active turn');

  sessions[0].opts.emit({
    kind: 'message',
    message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions[0].inputs.length, 1);

  sessions[0].opts.emit({ kind: 'message', message: { type: 'result' } });
  await waitFor(
    () => (
      sessions[0].inputs.length === 2
      && mailbox.get('task-a', first.id)?.status === 'delivered'
    ),
    'first follow-up was not durably marked delivered',
  );
  assert.match(sessions[0].inputs[1], /first follow-up/);
  assert.equal(mailbox.get('task-a', first.id).status, 'delivered');
  assert.equal(mailbox.get('task-a', second.id).status, 'queued');

  sessions[0].opts.emit({
    kind: 'message',
    message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first ack' }] } },
  });
  sessions[0].opts.emit({ kind: 'message', message: { type: 'result' } });
  await waitFor(
    () => (
      sessions[0].inputs.length === 3
      && mailbox.get('task-a', first.id)?.status === 'acknowledged'
    ),
    'first acknowledgement or second follow-up delivery did not become durable',
  );
  assert.match(sessions[0].inputs[2], /second follow-up/);
  assert.equal(mailbox.get('task-a', first.id).status, 'acknowledged');
});

test('a missing WorkReport gets one durable protocol correction before fail-closed', async (t) => {
  const { scheduler, sessions, mailbox } = await fixture(t);
  install(scheduler);
  await waitFor(() => sessions.length === 1, 'worker did not start');
  const initialInputs = sessions[0].inputs.length;

  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });
  await waitFor(
    () => (
      sessions[0].inputs.length === initialInputs + 1
      && mailbox.list('task-a').some((entry) => (
        entry.kind === 'follow-up'
        && entry.payload?.text?.includes('protocol correction')
        && entry.status === 'delivered'
      ))
    ),
    'missing WorkReport correction was not delivered',
  );
  assert.match(sessions[0].inputs.at(-1), /protocol correction/);
  assert.match(sessions[0].inputs.at(-1), /tests\.status must be passed, failed, or not-run/);
  assert.match(sessions[0].inputs.at(-1), /Every unresolved item must be/);
  const corrections = mailbox.list('task-a').filter((entry) => (
    entry.kind === 'follow-up'
    && entry.payload?.text?.includes('protocol correction')
  ));
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].status, 'delivered');
  assert.equal(scheduler.snapshot()[0].status, 'running');

  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });
  await waitFor(
    () => sessions.length === 2,
    'second missing WorkReport did not fork the report-recovery rework attempt',
  );
  assert.equal(scheduler.snapshot()[0].status, 'running', 'rework keeps the task alive');
  assert.equal(
    mailbox.list('task-a').filter((entry) => (
      entry.kind === 'follow-up'
      && entry.payload?.text?.includes('protocol rework')
    )).length,
    1,
  );

  // The rework attempt gets its own single correction, then fails closed.
  sessions[1].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });
  await waitFor(
    () => sessions[1].inputs.some((input) => input.includes('protocol correction')),
    'rework attempt did not receive its own protocol correction',
  );
  sessions[1].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });
  await waitFor(
    () => scheduler.snapshot()[0].status === 'failed',
    'missing WorkReport after the rework attempt did not fail closed',
  );
  assert.equal(sessions.length, 2, 'the report-recovery rework happens at most once per task');
});

test('an invalid WorkReport gets the same single correction without racing its turn end', async (t) => {
  const { scheduler, sessions, mailbox } = await fixture(t);
  install(scheduler);
  await waitFor(() => sessions.length === 1, 'worker did not start');
  const initialInputs = sessions[0].inputs.length;

  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: {
      kind: 'failed',
      code: 'invalid-work-report',
      message: 'tests.0.status must be passed, failed, or not-run',
      retryable: true,
    },
  });
  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });

  await waitFor(
    () => sessions[0].inputs.length === initialInputs + 1,
    'invalid WorkReport correction was not delivered',
  );
  assert.equal(scheduler.snapshot()[0].status, 'running');
  assert.equal(
    mailbox.list('task-a').filter((entry) => (
      entry.kind === 'follow-up'
      && entry.payload?.text?.includes('protocol correction')
    )).length,
    1,
  );

  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: {
      kind: 'failed',
      code: 'invalid-work-report',
      message: 'second invalid report',
      retryable: true,
    },
  });
  sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });

  await waitFor(
    () => sessions.length === 2,
    'second invalid WorkReport did not fork the report-recovery rework attempt',
  );
  assert.equal(scheduler.snapshot()[0].status, 'running', 'rework keeps the task alive');

  sessions[1].opts.emit({
    kind: 'worker-signal',
    signal: {
      kind: 'failed',
      code: 'invalid-work-report',
      message: 'still invalid in the rework attempt',
      retryable: true,
    },
  });
  sessions[1].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });
  await waitFor(
    () => sessions[1].inputs.some((input) => input.includes('protocol correction')),
    'rework attempt did not receive its own protocol correction',
  );
  sessions[1].opts.emit({
    kind: 'worker-signal',
    signal: {
      kind: 'failed',
      code: 'invalid-work-report',
      message: 'invalid after every recovery lever',
      retryable: true,
    },
  });
  sessions[1].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'ended', reason: 'completed' },
  });
  await waitFor(
    () => scheduler.snapshot()[0].status === 'failed',
    'invalid WorkReport after the rework attempt did not fail closed',
  );
  assert.equal(sessions.length, 2, 'the report-recovery rework happens at most once per task');
});

test('steering is durable before interrupt and never terminalizes the task turn', async (t) => {
  let meetingRoot;
  const setup = await fixture(t, {
    async onInterrupt(_session, reason, opts) {
      const journal = await readFile(join(meetingRoot, 'events.jsonl'), 'utf8');
      assert.match(journal, /task-message-enqueued/);
      assert.equal(reason, 'steer');
      opts.emit({
        kind: 'worker-signal',
        signal: { kind: 'ended', reason: 'interrupted' },
      });
    },
  });
  meetingRoot = join(setup.root, 'meeting');
  install(setup.scheduler);
  await waitFor(() => setup.sessions.length === 1, 'worker did not start');
  setup.sessions[0].opts.emit({
    kind: 'message',
    message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } },
  });

  const result = await setup.scheduler.steerTask('task-a', 'change direction');
  assert.deepEqual(result, { ok: true, queued: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(setup.scheduler.snapshot()[0].status, 'running');
  assert.match(setup.sessions[0].inputs.at(-1), /change direction/);
  assert.equal(setup.sessions[0].interruptReasons[0], 'steer');
});

test('canonical Worker progress acknowledges delegation for message-less backends', async (t) => {
  const setup = await fixture(t);
  install(setup.scheduler);
  await waitFor(() => setup.sessions.length === 1, 'worker did not start');

  const queued = await setup.scheduler.steerTask('task-a', 'apply after canonical progress');
  assert.deepEqual(queued, { ok: true, queued: true });
  setup.sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'progress', message: 'Codex consumed the delegated prompt.' },
  });

  await waitFor(
    () => (
      setup.sessions[0].interruptReasons.includes('steer')
      && setup.mailbox.list('task-a').some((message) => (
        message.kind === 'steer' && message.status === 'delivered'
      ))
    ),
    'queued steering was not delivered after canonical progress',
  );
  assert.match(setup.sessions[0].inputs.at(-1), /apply after canonical progress/);
  assert.equal(
    setup.mailbox.list('task-a').some((message) => (
      message.kind === 'steer' && message.status === 'delivered'
    )),
    true,
  );
  setup.sessions[0].opts.emit({
    kind: 'worker-signal',
    signal: { kind: 'progress', message: 'Codex consumed the steering update.' },
  });
  await waitFor(
    () => setup.mailbox.list('task-a').some((message) => (
      message.kind === 'steer' && message.status === 'acknowledged'
    )),
    'canonical progress did not acknowledge the delivered steering message',
  );
});

test('explicit interrupt preserves workspace and resumable Backend checkpoint', async (t) => {
  const setup = await fixture(t);
  install(setup.scheduler);
  await waitFor(() => setup.sessions.length === 1, 'worker did not start');

  const result = await setup.scheduler.interruptTask('task-a', 'pause safely');
  assert.equal(result.ok, true);
  const interrupted = setup.scheduler.snapshot()[0];
  assert.equal(interrupted.status, 'interrupted');
  assert.deepEqual(interrupted.workspace, setup.workspace);
  assert.deepEqual(interrupted.backendSession, {
    protocol: 'test-backend',
    sessionId: 'session-checkpoint',
  });
  assert.deepEqual(setup.releases, [{ taskId: 'task-a', removeWorktree: false }]);

  assert.deepEqual(await setup.scheduler.resolveRecoveredTask('task-a', 'continue-read-only'), { ok: true });
  await waitFor(() => setup.sessions.length === 2, 'continued worker did not start');
  assert.equal(setup.sessions[1].opts.sessionOptions.resumeSessionId, 'session-checkpoint');
});

test('failed follow-up delivery remains queued for retry', async (t) => {
  let sends = 0;
  const setup = await fixture(t, {
    onSendUserText() {
      sends += 1;
      if (sends > 1) throw new Error('transport unavailable');
    },
  });
  install(setup.scheduler);
  await waitFor(() => setup.sessions.length === 1, 'worker did not start');
  const message = await setup.scheduler.queueFollowUp('task-a', 'retry me');
  setup.sessions[0].opts.emit({ kind: 'message', message: { type: 'result' } });
  let journal = [];
  await waitFor(async () => {
    journal = await MeetingRepository.replay('meeting', join(setup.root, 'meeting'));
    return journal.some((event) => event.type === 'task-message-failed');
  }, 'failed follow-up did not journal its retryable delivery failure');
  assert.equal(setup.mailbox.get('task-a', message.id)?.status, 'queued');
  assert.equal(journal.some((event) => event.type === 'task-message-failed'), true);
});

test('Worker question reaches only Coordinator and forwarding creates a second mailbox event', async (t) => {
  const setup = await fixture(t);
  install(setup.scheduler, [
    { id: 'task-a', title: 'Task A', prompt: 'work A', deps: [] },
    { id: 'task-b', title: 'Task B', prompt: 'work B', deps: [] },
  ]);
  await waitFor(() => setup.sessions.length === 2, 'workers did not start');

  const question = await setup.scheduler.recordWorkerQuestion('task-a', 'Which API shape should I use?');
  assert.equal(setup.coordinatorInputs.length, 1);
  assert.match(setup.coordinatorInputs[0], /task-a.*Which API shape/);
  assert.equal(setup.sessions[1].inputs.some((input) => /Which API shape/.test(input)), false);

  const forwarded = await setup.scheduler.forwardTaskMessage('task-a', 'task-b', question.id);
  assert.equal(forwarded.replyTo, question.id);
  assert.equal(forwarded.sender, 'coordinator');
  assert.equal(setup.mailbox.list('task-a').length, 1);
  assert.equal(setup.mailbox.list('task-b').length, 1);
  assert.equal(setup.sessions[1].inputs.some((input) => /Which API shape/.test(input)), false);
});

test('terminal follow-up starts a new attempt and legacy steer uses the mailbox', async (t) => {
  const setup = await fixture(t);
  // 'failed' keeps the fresh-attempt semantics; accepted deliveries now reject
  // follow-ups entirely (createFinalDeliveryRework is the only legal reopen).
  setup.scheduler.restoreTasks([{
    id: 'task-a',
    title: 'Task A',
    prompt: 'old task',
    deps: [],
    status: 'failed',
    attempt: 1,
  }]);

  const followUp = await setup.scheduler.queueFollowUp('task-a', 'one more change');
  assert.equal(followUp.attempt, 2);
  assert.equal(setup.scheduler.snapshot()[0].attempt, 2);
  await waitFor(() => setup.sessions.length === 1, 'follow-up attempt did not start');
  setup.sessions[0].opts.emit({
    kind: 'message',
    message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ready' }] } },
  });
  const result = await setup.scheduler.steerWorker('task-a', 'legacy path');
  assert.equal(result.ok, true);
  assert.equal(
    setup.mailbox.list('task-a').some((message) => message.kind === 'steer'),
    true,
  );
});

test('stale Worker attempts cannot ask questions for the current attempt', async (t) => {
  const setup = await fixture(t);
  install(setup.scheduler);
  await waitFor(() => setup.sessions.length === 1, 'worker did not start');

  await assert.rejects(
    setup.scheduler.recordWorkerQuestion('task-a', 'stale question', 2),
    /stale worker attempt 2; current attempt is 1/,
  );
  assert.equal(setup.mailbox.list('task-a').length, 0);
  assert.equal(setup.coordinatorInputs.length, 0);
});

test('Coordinator cannot forward a Worker question that it never received', async (t) => {
  const setup = await fixture(t);
  install(setup.scheduler, [
    { id: 'task-a', title: 'Task A', prompt: 'work A', deps: [] },
    { id: 'task-b', title: 'Task B', prompt: 'work B', deps: [] },
  ]);
  await waitFor(() => setup.sessions.length === 2, 'workers did not start');

  const queued = await setup.mailbox.enqueue({
    taskId: 'task-a',
    attempt: 1,
    sender: 'worker',
    kind: 'question',
    payload: { text: 'unseen question' },
  });
  await assert.rejects(
    setup.scheduler.forwardTaskMessage('task-a', 'task-b', queued.id),
    /must have reached the Coordinator/,
  );
  assert.equal(setup.mailbox.list('task-b').length, 0);
});

test('Scheduler enforces message bounds even outside MCP validation', async (t) => {
  const setup = await fixture(t);
  install(setup.scheduler);
  await waitFor(() => setup.sessions.length === 1, 'worker did not start');

  await assert.rejects(
    setup.scheduler.queueFollowUp('task-a', 'x'.repeat(100_001)),
    /exceeds 100000 characters/,
  );
  await assert.rejects(
    setup.scheduler.interruptTask('task-a', 'x'.repeat(20_001)),
    /exceeds 20000 characters/,
  );
  assert.equal(setup.mailbox.list('task-a').length, 0);
});
