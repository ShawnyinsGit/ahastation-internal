// observe-session-actions.test.mjs — Host voice-intent actions on observed
// sessions: input sanitizer, send-text guard rails (no tty / rate limit /
// typed failures), focus fallbacks, and the id resolver the Host tools use.
// All subprocess/fs effects are injected — nothing here touches a real tty
// or AppleScript.
//
// Run after `npm run build:electron`.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  focusObservedSession,
  hasCodexDesktopEvidence,
  listBoardableObservedSessionRows,
  resetSendTextRateLimits,
  resolveObservedSession,
  runObservedSessionAction,
  sanitizeObservedInput,
  sendTextToObservedSession,
  SEND_TEXT_MAX_CHARS,
} from '../dist-electron/observe/session-actions.js';
import { formatObservedActionOutcome } from '../dist-electron/meeting-mcp.js';

const BASE = {
  nativeSessionId: 'native-1',
  projectId: 'project-sha',
  cwd: '/Users/test/work/ahakeyconfig',
  inferred: true,
  titleSource: 'session-index',
  isNoise: false,
};

function session(overrides = {}) {
  return {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    clientKind: 'kimi',
    projectName: 'ahakeyconfig',
    title: '跑一下测试',
    state: 'waiting',
    activity: 'waiting',
    lastActiveAt: 10_000,
    pid: 5102,
    tty: 's015',
    evidence: ['file:/Users/test/.kimi/sessions/native-1.jsonl', 'pid:5102 via fd'],
    ...BASE,
    ...overrides,
  };
}

/** Codex Desktop thread row: chat-process evidence, no tty of its own. */
function desktopSession(overrides = {}) {
  return session({
    id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
    clientKind: 'codex',
    projectName: 'ahastation',
    title: '桌面线程',
    state: 'active',
    activity: 'thinking',
    pid: 97611,
    tty: undefined,
    evidence: ['chat-process pid 97611 alive', 'desktop-host:app-server pid 86693'],
    ...overrides,
  });
}

function recordingExec(impl = async () => ({ stdout: '', stderr: '' })) {
  const calls = [];
  const exec = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return impl(cmd, args, options);
  };
  return { calls, exec };
}

// ---------------------------------------------------------------------------
// sanitizeObservedInput
// ---------------------------------------------------------------------------

test('sanitize: strips control chars except newline (tab/CR/ESC/bidi)', () => {
  assert.equal(sanitizeObservedInput('ab\tcd'), 'abcd\n');
  assert.equal(sanitizeObservedInput('ab\r\ncd'), 'ab\ncd\n');
  assert.equal(sanitizeObservedInput('run ls\[2K'), 'run ls[2K\n'); // ESC stripped
  assert.equal(sanitizeObservedInput('ab\u202E\u2066cd'), 'abcd\n');
  assert.equal(sanitizeObservedInput('ab\0ef\x7fgh'), 'abefgh\n'); // NUL + DEL stripped
});

test('sanitize: exactly one trailing newline', () => {
  assert.equal(sanitizeObservedInput('abc'), 'abc\n');
  assert.equal(sanitizeObservedInput('abc\n'), 'abc\n');
  assert.equal(sanitizeObservedInput('abc\n\n\n'), 'abc\n');
  assert.equal(sanitizeObservedInput('y'), 'y\n');
});

test('sanitize: caps at 500 chars before the trailing newline', () => {
  const out = sanitizeObservedInput('x'.repeat(SEND_TEXT_MAX_CHARS + 100));
  assert.equal(out.length, SEND_TEXT_MAX_CHARS + 1);
  assert.equal(out, `${'x'.repeat(SEND_TEXT_MAX_CHARS)}\n`);
});

test('sanitize: empty / control-only input degrades to empty string', () => {
  assert.equal(sanitizeObservedInput(''), '');
  assert.equal(sanitizeObservedInput('   \n\n  '), '');
  assert.equal(sanitizeObservedInput('\t\r\0'), '');
});

// ---------------------------------------------------------------------------
// sendTextToObservedSession — guard rails
// ---------------------------------------------------------------------------

test('send-text: no live pid → typed no-pid failure, nothing written', async () => {
  const writes = [];
  const result = await sendTextToObservedSession(session({ pid: undefined }), 'hi', {
    writeFileImpl: async (...args) => { writes.push(args); },
  });
  assert.deepEqual(result, { ok: false, reason: 'no-pid' });
  assert.equal(writes.length, 0);
});

test('send-text: no tty / ?? tty → typed no-tty failure, nothing written', async () => {
  const writes = [];
  const deps = { writeFileImpl: async (...args) => { writes.push(args); } };
  assert.deepEqual(
    await sendTextToObservedSession(session({ tty: undefined }), 'hi', deps),
    { ok: false, reason: 'no-tty' },
  );
  assert.deepEqual(
    await sendTextToObservedSession(session({ tty: '??' }), 'hi', deps),
    { ok: false, reason: 'no-tty' },
  );
  assert.equal(writes.length, 0);
});

test('send-text: poisoned tty value → invalid-tty, never a /dev path', async () => {
  const writes = [];
  const result = await sendTextToObservedSession(session({ tty: '../etc/passwd' }), 'hi', {
    writeFileImpl: async (...args) => { writes.push(args); },
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid-tty' });
  assert.equal(writes.length, 0);
});

test('send-text: empty-after-sanitize → empty-text failure', async () => {
  const result = await sendTextToObservedSession(session(), '\t\r  ');
  assert.deepEqual(result, { ok: false, reason: 'empty-text' });
});

test('send-text: writes sanitized text to /dev/tty<tt> with one Return', async () => {
  resetSendTextRateLimits();
  const writes = [];
  const result = await sendTextToObservedSession(session(), '跑一下测试\r\n', {
    now: () => 100_000,
    writeFileImpl: async (...args) => { writes.push(args); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, Buffer.byteLength('跑一下测试\n', 'utf8'));
  assert.deepEqual(writes, [['/dev/ttys015', '跑一下测试\n']]);
});

test('send-text: per-session 2s rate limit; other sessions unaffected', async () => {
  resetSendTextRateLimits();
  const writes = [];
  const deps = {
    writeFileImpl: async (...args) => { writes.push(args); },
  };
  let now = 200_000;
  deps.now = () => now;
  const target = session();
  const first = await sendTextToObservedSession(target, 'one', deps);
  assert.equal(first.ok, true);
  // Same session, 500ms later → limited.
  now += 500;
  const limited = await sendTextToObservedSession(target, 'two', deps);
  assert.equal(limited.ok, false);
  assert.equal(limited.reason, 'rate-limited');
  assert.equal(limited.retryAfterMs, 1_500);
  // A different session id is not limited.
  const other = await sendTextToObservedSession(session({ id: 'ccccccccccccccccccccccccccccccccccccccc3' }), 'two', deps);
  assert.equal(other.ok, true);
  // After the window passes, the original session sends again.
  now += 1_500;
  const third = await sendTextToObservedSession(target, 'three', deps);
  assert.equal(third.ok, true);
  assert.equal(writes.length, 3);
});

test('send-text: write failure → typed write-failed, never throws', async () => {
  resetSendTextRateLimits();
  const result = await sendTextToObservedSession(session(), 'hi', {
    now: () => 300_000,
    writeFileImpl: async () => { throw new Error('EIO: no such terminal'); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'write-failed');
  assert.match(result.detail, /EIO/);
});

// ---------------------------------------------------------------------------
// focusObservedSession
// ---------------------------------------------------------------------------

test('focus: tty session → osascript frontmost by unix pid', async () => {
  const { calls, exec } = recordingExec();
  const result = await focusObservedSession(session(), { execImpl: exec });
  assert.deepEqual(result, { ok: true, via: 'frontmost' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'osascript');
  assert.match(calls[0].args[1], /unix id is 5102/);
  assert.equal(calls[0].options.timeoutMs, 3_000);
});

test('focus: frontmost failure on a plain CLI session → typed failure', async () => {
  const { exec } = recordingExec(async () => { throw new Error('not allowed'); });
  const result = await focusObservedSession(session(), { execImpl: exec });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'frontmost-failed');
  assert.match(result.detail, /not allowed/);
});

test('focus: desktop thread without tty → open -a ChatGPT, no osascript', async () => {
  const { calls, exec } = recordingExec();
  const result = await focusObservedSession(desktopSession(), { execImpl: exec });
  assert.deepEqual(result, { ok: true, via: 'open-chatgpt' });
  assert.deepEqual(calls.map((c) => c.cmd), ['open']);
  assert.deepEqual(calls[0].args, ['-a', 'ChatGPT']);
});

test('focus: frontmost failure + desktop evidence → falls back to ChatGPT', async () => {
  const { calls, exec } = recordingExec(async (cmd) => {
    if (cmd === 'osascript') throw new Error('assistive access denied');
    return { stdout: '', stderr: '' };
  });
  const result = await focusObservedSession(desktopSession({ tty: 's001' }), { execImpl: exec });
  assert.deepEqual(result, { ok: true, via: 'open-chatgpt' });
  assert.deepEqual(calls.map((c) => c.cmd), ['osascript', 'open']);
});

test('focus: no tty and no desktop evidence → unsupported', async () => {
  const { calls, exec } = recordingExec();
  const result = await focusObservedSession(session({ tty: undefined }), { execImpl: exec });
  assert.deepEqual(result, { ok: false, reason: 'unsupported' });
  assert.equal(calls.length, 0);
});

test('focus: no pid → no-pid; open failure → open-failed', async () => {
  const noPid = await focusObservedSession(session({ pid: undefined }));
  assert.deepEqual(noPid, { ok: false, reason: 'no-pid' });
  const { exec } = recordingExec(async () => { throw new Error('no app'); });
  const openFailed = await focusObservedSession(desktopSession(), { execImpl: exec });
  assert.equal(openFailed.ok, false);
  assert.equal(openFailed.reason, 'open-failed');
});

test('hasCodexDesktopEvidence: only codex rows with desktop/chat evidence', () => {
  assert.equal(hasCodexDesktopEvidence(desktopSession()), true);
  assert.equal(hasCodexDesktopEvidence(session()), false);
  assert.equal(hasCodexDesktopEvidence(session({ clientKind: 'codex' })), false);
});

// ---------------------------------------------------------------------------
// resolver (what the Host tools use)
// ---------------------------------------------------------------------------

test('resolver: exact id and unique ≥4-char prefix resolve', () => {
  const sessions = [session(), desktopSession()];
  assert.equal(resolveObservedSession(sessions, session().id).kind, 'ok');
  const prefixed = resolveObservedSession(sessions, 'bbbb');
  assert.equal(prefixed.kind, 'ok');
  assert.equal(prefixed.session.id, desktopSession().id);
});

test('resolver: 2+ prefix candidates → ambiguous, never a guess', () => {
  const sessions = [
    session(),
    session({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9' }),
  ];
  const outcome = resolveObservedSession(sessions, 'aaaa');
  assert.equal(outcome.kind, 'ambiguous');
  assert.equal(outcome.candidates.length, 2);
  assert.equal(outcome.candidates[0].projectName, 'ahakeyconfig');
});

test('resolver: short prefix / unknown id → not-found', () => {
  const sessions = [session()];
  assert.equal(resolveObservedSession(sessions, 'aaa').kind, 'not-found');
  assert.equal(resolveObservedSession(sessions, 'dddddddd').kind, 'not-found');
});

// ---------------------------------------------------------------------------
// list filtering (observed_sessions_list rows)
// ---------------------------------------------------------------------------

test('list rows: board-visibility filter + tty surface', () => {
  const now = 100_000;
  const sessions = [
    session({ id: 'id-waiting', state: 'waiting' }),
    session({ id: 'id-noise', isNoise: true, state: 'waiting' }),
    session({ id: 'id-idle-live', state: 'idle' }),
    session({ id: 'id-idle-dead', state: 'idle', pid: undefined, tty: undefined }),
    session({ id: 'id-done-recent', state: 'done', lastActiveAt: now - 60_000 }),
    session({ id: 'id-done-stale', state: 'done', lastActiveAt: now - 31 * 60_000 }),
    session({ id: 'id-unknown', state: 'unknown' }),
  ];
  const rows = listBoardableObservedSessionRows({ sessions, scannedAt: now }, now);
  const ids = rows.map((row) => row.id).sort();
  assert.deepEqual(ids, ['id-done-recent', 'id-idle-live', 'id-waiting']);
  const waiting = rows.find((row) => row.id === 'id-waiting');
  assert.equal(waiting.tty, 's015');
  assert.equal(waiting.clientKind, 'kimi');
  assert.equal(waiting.projectName, 'ahakeyconfig');
  // Waiting first, then most-recently-active.
  assert.equal(rows[0].id, 'id-waiting');
});

// ---------------------------------------------------------------------------
// runObservedSessionAction (tool call end to end, injected impls)
// ---------------------------------------------------------------------------

test('action: ambiguous id short-circuits — no exec, candidates listed', async () => {
  const { calls, exec } = recordingExec();
  const sessions = [
    session(),
    session({ id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9' }),
  ];
  const outcome = await runObservedSessionAction(
    { sessions, scannedAt: 100_000 },
    { kind: 'focus', id: 'aaaa' },
    { execImpl: exec, now: () => 100_000 },
  );
  assert.equal(outcome.kind, 'ambiguous');
  assert.equal(outcome.candidates.length, 2);
  assert.equal(calls.length, 0);
});

test('action: not-found id → typed outcome, no exec', async () => {
  const { calls, exec } = recordingExec();
  const outcome = await runObservedSessionAction(
    { sessions: [session()], scannedAt: 100_000 },
    { kind: 'send-text', id: 'dddddddd', text: 'hi' },
    { execImpl: exec, now: () => 100_000 },
  );
  assert.deepEqual(outcome, { kind: 'not-found', id: 'dddddddd' });
  assert.equal(calls.length, 0);
});

test('action: desktop-no-tty send-text → no-tty outcome (Host offers focus)', async () => {
  const outcome = await runObservedSessionAction(
    { sessions: [desktopSession()], scannedAt: 100_000 },
    { kind: 'send-text', id: 'bbbb', text: '继续' },
    { now: () => 100_000 },
  );
  assert.equal(outcome.kind, 'send-text');
  assert.deepEqual(outcome.result, { ok: false, reason: 'no-tty' });
});

test('action: send-text happy path resolves prefix and writes once', async () => {
  resetSendTextRateLimits();
  const writes = [];
  const outcome = await runObservedSessionAction(
    { sessions: [session()], scannedAt: 100_000 },
    { kind: 'send-text', id: 'aaaa', text: 'y' },
    { now: () => 100_000, writeFileImpl: async (...args) => { writes.push(args); } },
  );
  assert.equal(outcome.kind, 'send-text');
  assert.equal(outcome.result.ok, true);
  assert.deepEqual(writes, [['/dev/ttys015', 'y\n']]);
});

test('action: hidden (non-boardable) sessions are not actionable', async () => {
  const outcome = await runObservedSessionAction(
    { sessions: [session({ state: 'idle', pid: undefined, tty: undefined })], scannedAt: 100_000 },
    { kind: 'focus', id: 'aaaa' },
    { now: () => 100_000 },
  );
  assert.equal(outcome.kind, 'not-found');
});

// ---------------------------------------------------------------------------
// Host-facing outcome formatting (what the model reads back)
// ---------------------------------------------------------------------------

test('format: ambiguous outcome tells the model to ask, not guess', () => {
  const rendered = formatObservedActionOutcome({
    kind: 'ambiguous',
    id: 'aaaa',
    candidates: [session(), session({ id: 'aaaa9' })].map((s) => ({
      id: s.id, clientKind: s.clientKind, projectName: s.projectName,
      title: s.title, state: s.state, activity: s.activity, lastActiveAt: s.lastActiveAt,
    })),
  });
  assert.equal(rendered.isError, true);
  assert.match(rendered.content[0].text, /ambiguous: 2 observed sessions/);
  assert.match(rendered.content[0].text, /do NOT guess/);
  assert.match(rendered.content[0].text, /ahakeyconfig · kimi/);
});

test('format: desktop no-tty points at focus; success echoes the target', () => {
  const noTty = formatObservedActionOutcome(
    { kind: 'send-text', result: { ok: false, reason: 'no-tty' } },
    '向 ahastation 的 Codex 桌面线程发送输入',
  );
  assert.equal(noTty.isError, true);
  assert.match(noTty.content[0].text, /no terminal \(tty\)/);
  assert.match(noTty.content[0].text, /observed_session_focus/);
  const ok = formatObservedActionOutcome(
    { kind: 'send-text', result: { ok: true, bytes: 7 } },
    '向 ahakeyconfig 的 Kimi 窗口发送输入',
  );
  assert.match(ok.content[0].text, /typed 7 bytes into 向 ahakeyconfig 的 Kimi 窗口发送输入/);
});
