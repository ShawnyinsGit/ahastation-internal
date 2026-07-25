import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyOpenCodeToolRisk,
  decideTaskPermission,
  mapOpenCodeToolName,
  mapUiDecisionToOpencode,
  PermissionBroker,
} from '../dist-electron/permission-broker.js';
import { classifyToolRisk, isInProcSafeTool } from '../dist-electron/auto-approve-policy.js';
import { compileTaskAuthority } from '../dist-electron/task-authority.js';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('canonical decisions use only a valid bounded task grant', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-broker-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const approvedAt = 1_700_000_000_000;
  const grant = compileTaskAuthority(
    'task-a',
    1,
    1,
    'approval-a',
    root,
    {
      writePaths: ['src'],
      toolKinds: ['read', 'write'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 30_000,
      networkHosts: [],
    },
    approvedAt,
  );
  const normalized = {
    ok: true,
    request: {
      schemaVersion: 1,
      taskId: 'task-a',
      attempt: 1,
      backendId: 'codex',
      kind: 'write',
      workspaceRoot: root,
      readPaths: [],
      writePaths: ['src/a.ts'],
      networkHosts: [],
      environmentKeys: [],
      sideEffects: ['workspace-write'],
      nativeRequestId: 'native-a',
    },
  };
  assert.deepEqual(
    decideTaskPermission(normalized, grant, approvedAt + 1).decision,
    { kind: 'allow', reason: 'within-task-authority' },
  );
  assert.deepEqual(
    decideTaskPermission(normalized, undefined, approvedAt + 1).decision,
    { kind: 'ask-user', reason: 'authority-miss:task-authority-missing' },
  );
  assert.equal(
    decideTaskPermission({
      ok: false,
      diagnostic: 'opaque-shell-command',
      requiresUser: true,
    }, grant, approvedAt + 1).decision.kind,
    'ask-user',
  );
  assert.deepEqual(
    decideTaskPermission({
      ok: false,
      diagnostic: 'opaque-shell-command',
      requiresUser: true,
    }, grant, approvedAt + 1, {
      backendId: 'codex',
      taskId: 'task-a',
      attempt: 1,
      nativeRequestId: 'native-opaque',
      toolName: 'Bash',
    }).safeInput,
    {
      backendId: 'codex',
      taskId: 'task-a',
      attempt: 1,
      nativeRequestId: 'native-opaque',
      toolName: 'Bash',
      normalizationDiagnostic: 'opaque-shell-command',
      requiresUser: true,
    },
  );
});

// ---------------------------------------------------------------------------
// In-proc tool whitelist: meeting MCP + Task bypass the external ask-user path
// ---------------------------------------------------------------------------

test('in-proc meeting tools and Task are whitelisted, other MCP tools are not', () => {
  assert.equal(isInProcSafeTool('mcp__meeting__report_progress'), true);
  assert.equal(isInProcSafeTool('mcp__meeting-worker__submit_report'), true);
  assert.equal(isInProcSafeTool('Task'), true);
  assert.equal(isInProcSafeTool('mcp__embedded-browser__click'), false);
  assert.equal(isInProcSafeTool('mcp__computer-use__type'), false);
  assert.equal(isInProcSafeTool('mcp__github__create_issue'), false);
  assert.equal(isInProcSafeTool('Bash'), false);
});

test('observed-session action tools are carved out of every safe list', () => {
  // They ARE meeting-MCP hosted, but they reach into other apps' windows —
  // never whitelisted, never auto-approved; classify destructive so every
  // scope (off/read/all) surfaces an approval first.
  assert.equal(isInProcSafeTool('mcp__meeting__observed_session_focus'), false);
  assert.equal(isInProcSafeTool('mcp__meeting__observed_session_send_text'), false);
  assert.equal(classifyToolRisk('mcp__meeting__observed_session_focus'), 'destructive');
  assert.equal(classifyToolRisk('mcp__meeting__observed_session_send_text'), 'destructive');
  // The read-only list tool stays safe (prefix rule untouched).
  assert.equal(isInProcSafeTool('mcp__meeting__observed_sessions_list'), true);
  assert.equal(classifyToolRisk('mcp__meeting__observed_sessions_list'), 'safe');
});

function externalNormalized(root) {
  return {
    ok: true,
    request: {
      schemaVersion: 1,
      taskId: 'task-a',
      attempt: 1,
      backendId: 'codex',
      kind: 'external',
      workspaceRoot: root,
      readPaths: [],
      writePaths: [],
      networkHosts: [],
      environmentKeys: [],
      sideEffects: ['external-service'],
      nativeRequestId: 'native-ext',
    },
  };
}

test('in-proc external tools allow even without a grant, and are journalled', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-broker-inproc-'));
  const identity = (toolName) => ({
    backendId: 'codex',
    taskId: 'task-a',
    attempt: 1,
    nativeRequestId: 'native-ext',
    toolName,
  });
  for (const toolName of ['mcp__meeting-worker__submit_report', 'mcp__meeting__report_progress', 'Task']) {
    const result = decideTaskPermission(externalNormalized(root), undefined, Date.now(), identity(toolName));
    assert.deepEqual(result.decision, { kind: 'allow', reason: 'in-proc-tool-safe' }, toolName);
    // The decision still carries a canonical safeInput for the journal.
    assert.equal(result.safeInput.taskId, 'task-a');
    assert.equal(result.safeInput.kind, 'external');
  }
});

test('non-whitelisted external tools keep the previous behavior', () => {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-broker-ext-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  const approvedAt = 1_700_000_000_000;
  const grant = compileTaskAuthority(
    'task-a',
    1,
    1,
    'approval-a',
    root,
    {
      writePaths: ['src'],
      toolKinds: ['read', 'write', 'external'],
      workingDirectories: ['.'],
      commands: [],
      environmentKeys: [],
      maxCommandTimeoutMs: 30_000,
      networkHosts: [],
    },
    approvedAt,
  );
  const identity = {
    backendId: 'codex',
    taskId: 'task-a',
    attempt: 1,
    nativeRequestId: 'native-ext',
    toolName: 'mcp__embedded-browser__click',
  };
  // With a grant: external stays ask-user (high-risk).
  assert.equal(
    decideTaskPermission(externalNormalized(root), grant, approvedAt + 1, identity).decision.kind,
    'ask-user',
  );
  // Without a grant: escalate to an approval card instead of stranding the
  // Worker with a hard deny the user can never act on.
  assert.deepEqual(
    decideTaskPermission(externalNormalized(root), undefined, approvedAt + 1, identity).decision,
    { kind: 'ask-user', reason: 'authority-miss:task-authority-missing' },
  );
  // Whitelist never applies to non-external kinds: a workspace write from a
  // meeting-prefixed tool name still goes through the grant.
  const writeNormalized = {
    ok: true,
    request: {
      ...externalNormalized(root).request,
      kind: 'write',
      writePaths: ['src/a.ts'],
      sideEffects: ['workspace-write'],
    },
  };
  assert.deepEqual(
    decideTaskPermission(writeNormalized, undefined, approvedAt + 1, {
      ...identity,
      toolName: 'mcp__meeting-worker__submit_report',
    }).decision,
    { kind: 'ask-user', reason: 'authority-miss:task-authority-missing' },
  );
});
