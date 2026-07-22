import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOpenCodeToolRisk,
  mapOpenCodeToolName,
  mapUiDecisionToOpencode,
  PermissionBroker,
} from '../dist-electron/permission-broker.js';

// ---------------------------------------------------------------------------
// Tool-name mapping: known → policy classification, unknown → destructive
// ---------------------------------------------------------------------------

test('opencode tool names map onto the SAFE_BUILTIN_TOOLS classification', () => {
  for (const safe of ['read', 'glob', 'grep', 'webfetch', 'websearch', 'task', 'todowrite']) {
    assert.equal(classifyOpenCodeToolRisk(safe), 'safe', `${safe} should be safe`);
  }
  for (const destructive of ['bash', 'edit', 'write', 'patch']) {
    assert.equal(classifyOpenCodeToolRisk(destructive), 'destructive', `${destructive} should be destructive`);
  }
});

test('unknown opencode tool names fail-safe to destructive', () => {
  assert.equal(classifyOpenCodeToolRisk('frobnicate'), 'destructive');
  assert.equal(classifyOpenCodeToolRisk(''), 'destructive');
  assert.equal(mapOpenCodeToolName('Read'), 'Read'); // case-insensitive lookup
  assert.equal(classifyOpenCodeToolRisk('READ'), 'safe');
  assert.equal(classifyOpenCodeToolRisk('BASH'), 'destructive');
});

// ---------------------------------------------------------------------------
// Value-domain mapping: UI allow/deny → opencode once/reject
// ---------------------------------------------------------------------------

test('UI decisions map to opencode once/reject (always is never produced)', () => {
  assert.equal(mapUiDecisionToOpencode('allow'), 'once');
  assert.equal(mapUiDecisionToOpencode('deny'), 'reject');
});

// ---------------------------------------------------------------------------
// Broker harness: captured replies + meeting events + manual timers
// ---------------------------------------------------------------------------

function makeHarness({ scope = 'off', confirmDestructive, timeoutMs = 120_000 } = {}) {
  const replies = [];
  const meetingEvents = [];
  const timers = new Map();
  let seq = 0;
  const broker = new PermissionBroker({
    getAutoApproveScope: () => scope,
    confirmDestructive,
    timeoutMs,
    reply: (request, response, reason) => replies.push({ id: request.id, toolName: request.toolName, response, reason }),
    emitToMeeting: (event) => meetingEvents.push(event),
    setTimeoutFn: (cb, ms) => {
      const id = ++seq;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimeoutFn: (id) => { timers.delete(id); },
  });
  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const t of pending) t.cb();
  };
  const req = (id, toolName = 'bash') => ({ id, backendId: 'opencode', sessionID: 'ses_1', toolName, input: {} });
  return { broker, replies, meetingEvents, timers, fireTimers, req };
}

// ---------------------------------------------------------------------------
// Decision flow
// ---------------------------------------------------------------------------

test('safe tool under auto-approve scope is auto-allowed once, never pending', async () => {
  const { broker, replies, meetingEvents, req } = makeHarness({ scope: 'read' });
  await broker.submit(req('p1', 'read'));
  assert.deepEqual(replies, [{ id: 'p1', toolName: 'read', response: 'once', reason: 'auto-approve' }]);
  assert.equal(broker.size, 0);
  assert.deepEqual(meetingEvents, []);
});

test('safe tool under scope off goes to the meeting-UI card', async () => {
  const { broker, replies, meetingEvents, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'read'));
  assert.equal(broker.size, 1);
  assert.equal(meetingEvents.length, 1);
  assert.equal(meetingEvents[0].kind, 'permission-request');
  assert.equal(meetingEvents[0].id, 'p1');
  assert.deepEqual(replies, []);
});

test('destructive tool goes through the native confirmer, not the UI card', async () => {
  const { broker, replies, meetingEvents, req } = makeHarness({
    scope: 'off',
    confirmDestructive: async () => true,
  });
  await broker.submit(req('p1', 'bash'));
  assert.deepEqual(replies, [{ id: 'p1', toolName: 'bash', response: 'once', reason: 'native-confirm' }]);
  assert.deepEqual(meetingEvents, []);
  assert.equal(broker.size, 0);
});

test('native confirmer denial maps to reject', async () => {
  const { broker, replies, req } = makeHarness({
    scope: 'off',
    confirmDestructive: async () => false,
  });
  await broker.submit(req('p1', 'bash'));
  assert.deepEqual(replies, [{ id: 'p1', toolName: 'bash', response: 'reject', reason: 'native-confirm' }]);
});

test('destructive tool without a native confirmer degrades to the UI card', async () => {
  const { broker, meetingEvents, req } = makeHarness({ scope: 'all' });
  await broker.submit(req('p1', 'bash'));
  assert.equal(meetingEvents.length, 1);
  assert.equal(meetingEvents[0].kind, 'permission-request');
  assert.equal(broker.size, 1);
});

// ---------------------------------------------------------------------------
// UI resolution + broadcast mismatch
// ---------------------------------------------------------------------------

test('resolveUi answers the holding request; mismatched ids no-op', async () => {
  const { broker, replies, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'bash'));
  assert.equal(broker.resolveUi('someone-elses-id', 'allow'), false);
  assert.deepEqual(replies, []);
  assert.equal(broker.resolveUi('p1', 'allow'), true);
  assert.deepEqual(replies, [{ id: 'p1', toolName: 'bash', response: 'once', reason: 'ui' }]);
  // Second resolve of the same id is a no-op (already answered).
  assert.equal(broker.resolveUi('p1', 'deny'), false);
  assert.equal(replies.length, 1);
});

test('resolveUi deny maps to reject', async () => {
  const { broker, replies, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'edit'));
  assert.equal(broker.resolveUi('p1', 'deny'), true);
  assert.deepEqual(replies, [{ id: 'p1', toolName: 'edit', response: 'reject', reason: 'ui' }]);
});

// ---------------------------------------------------------------------------
// Fail-closed timeout
// ---------------------------------------------------------------------------

test('unanswered requests are denied on timeout, with card withdrawal + notice', async () => {
  const { broker, replies, meetingEvents, fireTimers, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'bash'));
  assert.equal(broker.size, 1);
  fireTimers();
  assert.deepEqual(replies, [{ id: 'p1', toolName: 'bash', response: 'reject', reason: 'timeout' }]);
  assert.equal(broker.size, 0);
  assert.equal(meetingEvents[1].kind, 'permission-cancelled');
  assert.equal(meetingEvents[1].id, 'p1');
  assert.equal(meetingEvents[2].kind, 'message'); // user-facing timeout notice
  // A late UI decision on the expired id is a no-op.
  assert.equal(broker.resolveUi('p1', 'allow'), false);
  assert.equal(replies.length, 1);
});

test('answering before the deadline cancels the timeout (no double answer)', async () => {
  const { broker, replies, fireTimers, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'bash'));
  broker.resolveUi('p1', 'allow');
  fireTimers();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].response, 'once');
});

// ---------------------------------------------------------------------------
// permission.replied idempotent cancellation
// ---------------------------------------------------------------------------

test('cancelExternal dequeues and withdraws the card, idempotently', async () => {
  const { broker, replies, meetingEvents, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'bash'));
  assert.equal(broker.cancelExternal('p1'), true);
  assert.equal(broker.size, 0);
  assert.equal(meetingEvents.at(-1).kind, 'permission-cancelled');
  assert.equal(meetingEvents.at(-1).id, 'p1');
  // Re-delivery / unknown id → no-op, and no reply was ever sent.
  assert.equal(broker.cancelExternal('p1'), false);
  assert.equal(broker.cancelExternal('nope'), false);
  assert.deepEqual(replies, []);
});

// ---------------------------------------------------------------------------
// rejectAll on session end / app quit
// ---------------------------------------------------------------------------

test('rejectAll denies every pending request and returns the count', async () => {
  const { broker, replies, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'bash'));
  await broker.submit(req('p2', 'edit'));
  assert.equal(broker.rejectAll('shutdown'), 2);
  assert.deepEqual(replies, [
    { id: 'p1', toolName: 'bash', response: 'reject', reason: 'shutdown' },
    { id: 'p2', toolName: 'edit', response: 'reject', reason: 'shutdown' },
  ]);
  assert.equal(broker.size, 0);
  assert.equal(broker.resolveUi('p1', 'allow'), false);
});

// ---------------------------------------------------------------------------
// Idempotent submit
// ---------------------------------------------------------------------------

test('re-submitting the same permission id is a no-op', async () => {
  const { broker, meetingEvents, req } = makeHarness({ scope: 'off' });
  await broker.submit(req('p1', 'bash'));
  await broker.submit(req('p1', 'bash'));
  assert.equal(broker.size, 1);
  assert.equal(meetingEvents.length, 1);
});
