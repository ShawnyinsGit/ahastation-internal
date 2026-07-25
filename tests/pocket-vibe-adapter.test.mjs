import assert from 'node:assert/strict';
import test from 'node:test';

import { PocketVibeBackend } from '../dist-electron/backends/pocket-vibe-adapter.js';

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

/** Fake hub: routes /health, /v1/agents, POST /v1/turns, GET /v1/turns/{id}.
 *  `statuses` is the sequence of task payloads returned by successive polls
 *  (the last one repeats). */
function fakeHub({ statuses, turnId = 'turn-1' }) {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/health')) return jsonRes({ ok: true });
    if (url.endsWith('/v1/agents')) return jsonRes({ agents: [] });
    if (url.endsWith('/v1/turns') && init.method === 'POST') {
      return jsonRes({ ok: true, turn_id: turnId, task: { status: 'queued' } });
    }
    if (url.includes(`/v1/turns/${turnId}`)) {
      const task = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return jsonRes({ ok: true, task });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

function makeBackend(hub) {
  return new PocketVibeBackend({
    fetchImpl: hub.fetchImpl,
    pollIntervalMs: 1,
    turnTimeoutMs: 2_000,
    healthTimeoutMs: 500,
  });
}

function makeSession(backend, events, config = {}) {
  return backend.createSession({
    cwd: '/workspace',
    env: {
      POCKET_VIBE_HUB_URL: 'http://hub.test',
      POCKET_VIBE_TOOL_TOKEN: 'dev-tool-token',
    },
    ...config,
  }, (event) => events.push(event));
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

const report = {
  status: 'completed',
  summary: 'remote work done',
  files: [{ path: 'src/app.ts', action: 'modified' }],
  tests: [{ command: 'npm test', status: 'passed' }],
  unresolved: [],
};

test('Pocket Vibe worker turn queued→done maps to progress + delivery + ended', async () => {
  const hub = fakeHub({
    statuses: [
      { status: 'sent' },
      { status: 'acked' },
      { status: 'done', result: { json: { last_message: `完成。\n\`\`\`work-report\n${JSON.stringify(report)}\n\`\`\`` } } },
    ],
  });
  const events = [];
  const session = makeSession(makeBackend(hub), events, {
    executionRole: 'worker',
    model: 'linux-worker',
  });
  await session.start();
  session.sendUserText('do the task');

  await waitFor(
    () => events.find((e) => e.kind === 'worker-signal' && e.signal.kind === 'ended'),
    'worker turn did not terminate',
  );

  // POST carried the target agent id (model fallback), token header and metadata.
  const post = hub.calls.find((c) => c.url.endsWith('/v1/turns') && c.init.method === 'POST');
  assert.equal(post.init.headers['X-Pocket-Token'], 'dev-tool-token');
  const body = JSON.parse(post.init.body);
  assert.equal(body.target_agent_id, 'linux-worker');
  assert.equal(body.cwd, '/workspace');
  assert.equal(body.metadata.source, 'ahastation');
  assert.equal(body.prompt, 'do the task');

  // No provider-native chat messages leak into a worker session.
  assert.equal(events.some((e) => e.kind === 'message'), false);
  const signals = events.filter((e) => e.kind === 'worker-signal').map((e) => e.signal);
  assert.deepEqual(signals.at(-2), { kind: 'delivery', report });
  assert.deepEqual(signals.at(-1), { kind: 'ended', reason: 'completed' });
  // Visible text (frame stripped) is reported as progress before delivery.
  assert.ok(signals.some((s) => s.kind === 'progress' && s.message === '完成。'));
  session.end();
});

test('Pocket Vibe failed turn maps to a retryable failed signal + ended', async () => {
  const hub = fakeHub({
    statuses: [{ status: 'failed', error: 'agent crashed' }],
  });
  const events = [];
  const session = makeSession(makeBackend(hub), events, { executionRole: 'worker' });
  await session.start();
  session.sendUserText('boom');

  await waitFor(
    () => events.find((e) => e.kind === 'worker-signal' && e.signal.kind === 'ended'),
    'failed turn did not terminate',
  );
  const signals = events.filter((e) => e.kind === 'worker-signal').map((e) => e.signal);
  assert.deepEqual(signals.at(-2), {
    kind: 'failed',
    code: 'pocket-vibe-turn-failed',
    message: 'Pocket Vibe 远程任务失败：agent crashed',
    retryable: true,
  });
  assert.deepEqual(signals.at(-1), { kind: 'ended', reason: 'completed' });
  session.end();
});

test('Pocket Vibe done turn without a work-report frame fails closed', async () => {
  const hub = fakeHub({
    statuses: [{ status: 'done', result: { stdout: 'plain output, no frame' } }],
  });
  const events = [];
  const session = makeSession(makeBackend(hub), events, { executionRole: 'worker' });
  await session.start();
  session.sendUserText('no frame please');

  await waitFor(
    () => events.find((e) => e.kind === 'worker-signal' && e.signal.kind === 'ended'),
    'frame-less turn did not terminate',
  );
  const signals = events.filter((e) => e.kind === 'worker-signal').map((e) => e.signal);
  assert.equal(signals.at(-2).kind, 'failed');
  assert.equal(signals.at(-2).code, 'missing-work-report');
  assert.deepEqual(signals.at(-1), { kind: 'ended', reason: 'completed' });
  session.end();
});

test('Pocket Vibe interrupt is idempotent and stops polling', async () => {
  const hub = fakeHub({ statuses: [{ status: 'acked' }] });
  const events = [];
  const session = makeSession(makeBackend(hub), events, { executionRole: 'worker' });
  await session.start();
  session.sendUserText('long task');
  await waitFor(
    () => hub.calls.some((c) => c.url.includes('/v1/turns/turn-1')),
    'polling did not start',
  );

  await session.interrupt();
  await session.interrupt();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const endedSignals = events.filter(
    (e) => e.kind === 'worker-signal' && e.signal.kind === 'ended',
  );
  assert.equal(endedSignals.length, 1);
  assert.deepEqual(endedSignals[0].signal, { kind: 'ended', reason: 'interrupted' });
  const pollsAfterInterrupt = hub.calls.filter((c) => c.url.includes('/v1/turns/turn-1')).length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    hub.calls.filter((c) => c.url.includes('/v1/turns/turn-1')).length,
    pollsAfterInterrupt,
    'polling continued after interrupt',
  );
  session.end();
  session.end();
});

test('Pocket Vibe host turn emits assistant + result messages', async () => {
  const hub = fakeHub({
    statuses: [{ status: 'done', result: { stdout: 'host-visible answer' } }],
  });
  const events = [];
  const session = makeSession(makeBackend(hub), events, { executionRole: 'host' });
  await session.start();
  session.sendUserText('hello');

  await waitFor(
    () => events.find((e) => e.kind === 'message' && e.message.type === 'result'),
    'host turn did not emit a result message',
  );
  const assistant = events.find(
    (e) => e.kind === 'message' && e.message.type === 'assistant',
  );
  assert.equal(assistant.message.message.content[0].text, 'host-visible answer');
  assert.deepEqual(session.snapshot(), { protocol: 'pocket-vibe', sessionId: 'turn-1' });
  session.end();
});

test('Pocket Vibe start emits auth-required when the hub rejects the token', async () => {
  const hub = fakeHub({ statuses: [] });
  const original = hub.fetchImpl;
  hub.fetchImpl = async (url, init) => {
    if (url.endsWith('/v1/agents')) return jsonRes({ error: 'unauthorized' }, 401);
    return original(url, init);
  };
  const events = [];
  const session = makeSession(makeBackend(hub), events, { executionRole: 'host' });
  // Host mode fails FAST with a legible reason — otherwise HostGroup only
  // reports the cryptic "ended before readiness".
  await assert.rejects(
    () => session.start(),
    /tool token 被 hub 拒绝/,
  );
  assert.deepEqual(events, [{
    kind: 'auth-required',
    error: 'Pocket Vibe tool token 被 hub 拒绝（401/403），请在设置中检查 token。',
  }]);
  session.end();
});

test('Pocket Vibe host start fails fast when no token is configured', async () => {
  const hub = fakeHub({ statuses: [] });
  const events = [];
  const session = makeSession(makeBackend(hub), events, {
    executionRole: 'host',
    env: { POCKET_VIBE_HUB_URL: 'http://hub.test', POCKET_VIBE_TOOL_TOKEN: '' },
  });
  await assert.rejects(() => session.start(), /未配置 tool token/);
  const authEvent = events.find((e) => e.kind === 'auth-required');
  assert.ok(authEvent, 'expected an auth-required event');
  session.end();
});

test('Pocket Vibe host start throws a legible error when the hub is unreachable', async () => {
  const events = [];
  const session = makeSession(
    makeBackend({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    events,
    { executionRole: 'host' },
  );
  await assert.rejects(() => session.start(), /hub 不可达/);
  assert.ok(events.some((e) => e.kind === 'error' && /hub 不可达/.test(e.error)));
  session.end();
});

test('Pocket Vibe host dispatches meeting-command frames and strips them from chat', async () => {
  const commands = [];
  const hub = fakeHub({
    statuses: [{
      status: 'done',
      result: {
        json: {
          last_message: '我先安排任务。\n```meeting-command\n{"kind":"broadcast-hosts","question":"status?"}\n```',
        },
      },
    }],
  });
  const events = [];
  const session = makeSession(makeBackend(hub), events, {
    executionRole: 'host',
    extra: { meetingCommandHandler: (command) => commands.push(command) },
  });
  await session.start();
  session.sendUserText('ask experts');

  await waitFor(
    () => events.find((e) => e.kind === 'message' && e.message.type === 'result'),
    'host turn did not emit a result message',
  );
  assert.deepEqual(commands, [{ kind: 'broadcast-hosts', question: 'status?' }]);
  const assistant = events.find(
    (e) => e.kind === 'message' && e.message.type === 'assistant',
  );
  assert.equal(assistant.message.message.content[0].text, '我先安排任务。');
  session.end();
});

test('Pocket Vibe host dispatches every frame in a multi-frame reply', async () => {
  const commands = [];
  const hub = fakeHub({
    statuses: [{
      status: 'done',
      result: {
        stdout: '```meeting-command\n{"kind":"ask-host","hostId":"claude","question":"q1"}\n```\n中间文本\n```meeting-command\n{"kind":"save-memory","category":"point","content":"c","tags":[]}\n```',
      },
    }],
  });
  const events = [];
  const session = makeSession(makeBackend(hub), events, {
    executionRole: 'host',
    extra: { meetingCommandHandler: (command) => commands.push(command) },
  });
  await session.start();
  session.sendUserText('go');

  await waitFor(
    () => events.find((e) => e.kind === 'message' && e.message.type === 'result'),
    'host turn did not emit a result message',
  );
  assert.deepEqual(commands, [
    { kind: 'ask-host', hostId: 'claude', question: 'q1' },
    { kind: 'save-memory', category: 'point', content: 'c', tags: [] },
  ]);
  const assistant = events.find(
    (e) => e.kind === 'message' && e.message.type === 'assistant',
  );
  assert.equal(assistant.message.message.content[0].text, '中间文本');
  session.end();
});

test('Pocket Vibe host hides speak-protocol frames and acknowledges command-only output', async () => {
  const speakCommands = [];
  const speakHub = fakeHub({
    statuses: [{
      status: 'done',
      result: { stdout: '欢迎回来。\n```meeting-command\n{"kind":"speak","text":"欢迎回来。"}\n```' },
    }],
  });
  const speakEvents = [];
  const speakSession = makeSession(makeBackend(speakHub), speakEvents, {
    executionRole: 'host',
    extra: { meetingCommandHandler: (command) => speakCommands.push(command) },
  });
  await speakSession.start();
  speakSession.sendUserText('hi');
  await waitFor(
    () => speakEvents.find((e) => e.kind === 'message' && e.message.type === 'result'),
    'speak turn did not emit a result message',
  );
  assert.deepEqual(speakCommands, [{ kind: 'speak', text: '欢迎回来。' }]);
  assert.equal(
    speakEvents.some((e) => e.kind === 'message' && e.message.type === 'assistant'),
    false,
    'speak turns are narrated by the orchestrator, not re-emitted as chat',
  );
  speakSession.end();

  const ackHub = fakeHub({
    statuses: [{
      status: 'done',
      result: { stdout: '```meeting-command\n{"kind":"broadcast-hosts","question":"status?"}\n```' },
    }],
  });
  const ackEvents = [];
  const ackSession = makeSession(makeBackend(ackHub), ackEvents, {
    executionRole: 'host',
    extra: { meetingCommandHandler: () => {} },
  });
  await ackSession.start();
  ackSession.sendUserText('ask');
  await waitFor(
    () => ackEvents.find((e) => e.kind === 'message' && e.message.type === 'result'),
    'command-only turn did not emit a result message',
  );
  const assistant = ackEvents.find(
    (e) => e.kind === 'message' && e.message.type === 'assistant',
  );
  assert.equal(assistant.message.message.content[0].text, '我正在处理，有结果会马上告诉你。');
  ackSession.end();
});

test('Pocket Vibe host reports invalid meeting-command JSON as an error event', async () => {
  const hub = fakeHub({
    statuses: [{
      status: 'done',
      result: { stdout: '```meeting-command\n{not json}\n```' },
    }],
  });
  const events = [];
  const session = makeSession(makeBackend(hub), events, {
    executionRole: 'host',
    extra: { meetingCommandHandler: () => assert.fail('handler must not run on invalid JSON') },
  });
  await session.start();
  session.sendUserText('go');
  await waitFor(
    () => events.find((e) => e.kind === 'error'),
    'invalid frame did not surface an error event',
  );
  assert.match(events.find((e) => e.kind === 'error').error, /Invalid meeting-command JSON/);
  session.end();
});

test('Pocket Vibe replays the system prompt on every turn without session continuity', async () => {
  const hub = fakeHub({
    statuses: [{ status: 'done', result: { stdout: 'ok' } }],
  });
  const session = makeSession(makeBackend(hub), [], {
    executionRole: 'host',
    systemPrompt: 'PROTOCOL',
  });
  await session.start();
  session.sendUserText('first');
  await waitFor(
    () => hub.calls.filter((c) => c.init.method === 'POST').length === 1,
    'first turn not posted',
  );
  await waitFor(
    () => hub.calls.some((c) => c.url.includes('/v1/turns/turn-1')),
    'first turn not polled',
  );
  session.sendUserText('second');
  await waitFor(
    () => hub.calls.filter((c) => c.init.method === 'POST').length === 2,
    'second turn not posted',
  );
  const posts = hub.calls.filter((c) => c.init.method === 'POST');
  assert.match(JSON.parse(posts[0].init.body).prompt, /^PROTOCOL\n\nfirst$/);
  assert.match(JSON.parse(posts[1].init.body).prompt, /^PROTOCOL\n\nsecond$/);
  session.end();
});

test('Pocket Vibe capabilities allow coordinating a meeting', () => {
  const capabilities = new PocketVibeBackend().capabilities;
  assert.equal(capabilities.coordinate, true);
  assert.equal(capabilities.executeTasks, true);
  assert.equal(capabilities.mcp, false);
});

test('Pocket Vibe buildEnv maps auth entry to hub env vars', () => {
  const backend = new PocketVibeBackend();
  const env = backend.buildEnv({
    authMode: 'apikey',
    apiKey: 'dev-tool-token',
    baseUrl: 'http://127.0.0.1:8787',
    model: 'linux-worker',
  });
  assert.equal(env.POCKET_VIBE_HUB_URL, 'http://127.0.0.1:8787');
  assert.equal(env.POCKET_VIBE_TOOL_TOKEN, 'dev-tool-token');
  assert.notEqual(backend.resolveBinary(), null);
});

test('Pocket Vibe compileTaskProfile accepts any target id and downgrades workMode', () => {
  const backend = new PocketVibeBackend();
  const profile = backend.compileTaskProfile({
    schemaVersion: 1,
    backendId: 'pocket-vibe',
    modelPreference: 'win-codex-01',
    workMode: 'deep',
    contextMode: 'meeting-summary',
    timeoutMs: 1_800_000,
    maxTokenBudget: 200_000,
  }, {
    schemaVersion: 1,
    backendId: 'pocket-vibe',
    runtimeVersion: '1.0.0',
  });
  assert.equal(profile.backendId, 'pocket-vibe');
  assert.equal(profile.model, 'win-codex-01');
  assert.ok(profile.unsupported.includes('workMode'));
});
