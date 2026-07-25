import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyzeClaudeTail,
  isSyntheticClaudeUserLine,
  listClaudeTranscripts,
  parseClaudeTranscript,
} from '../dist-electron/observe/statefiles/claude-projects.js';
import {
  analyzeCodexTail,
  listCodexRollouts,
  loadCodexSessionIndex,
  parseCodexRollout,
  readCodexMeta,
} from '../dist-electron/observe/statefiles/codex-sessions.js';
import { MAX_LINE_BYTES, parseJsonLine } from '../dist-electron/observe/util.js';

const HOME = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'observe', 'home');

const SID_IDLE = 'c1a0de00-0000-4000-8000-000000000001';
const SID_EXEC = 'c1a0de00-0000-4000-8000-000000000002';
const SID_NOISE = 'c1a0de00-0000-4000-8000-000000000003';
const CODEX_PENDING = 'd0de0000-0000-7000-8000-0000000000a1';
const CODEX_EXEC_DONE = 'd0de0000-0000-7000-8000-0000000000a2';
const CODEX_WAITING = 'd0de0000-0000-7000-8000-0000000000a3';

// ---------------------------------------------------------------------------
// Claude transcripts
// ---------------------------------------------------------------------------

test('listClaudeTranscripts: finds all fixture transcripts', async () => {
  const refs = await listClaudeTranscripts(HOME);
  assert.equal(refs.length, 3);
  for (const ref of refs) {
    assert.ok(ref.mtimeMs > 0);
    assert.ok(ref.sizeBytes > 0);
  }
});

test('claude head scan: identity survives non-message leading lines', async () => {
  const refs = await listClaudeTranscripts(HOME);
  const ref = refs.find((r) => r.filePath.includes(SID_IDLE));
  const signal = await parseClaudeTranscript(ref);
  assert.equal(signal.nativeSessionId, SID_IDLE);
  assert.equal(signal.cwd, '/Users/test/work/project-alpha');
  assert.equal(signal.model, 'claude-fake-5');
  assert.equal(signal.tailSignals.gitBranch, 'main');
  // Title candidate: first real user prompt (unredacted at this layer).
  assert.match(signal.tailSignals.firstPromptTitle, /sk-ant-api03-FAKE/);
});

test('claude tail: synthetic user lines do not trigger Thinking', async () => {
  const refs = await listClaudeTranscripts(HOME);
  const ref = refs.find((r) => r.filePath.includes(SID_IDLE));
  const signal = await parseClaudeTranscript(ref);
  // Tail holds: tool_result wrapper, isMeta line, <command-name> line —
  // none of them are real user input, and a tool_use got closed earlier.
  assert.equal(signal.tailSignals.trailingRealUser, false);
  assert.equal(signal.tailSignals.unclosedToolUse, false);
});

test('claude tail: unclosed trailing tool_use is detected', async () => {
  const refs = await listClaudeTranscripts(HOME);
  const ref = refs.find((r) => r.filePath.includes(SID_EXEC));
  const signal = await parseClaudeTranscript(ref);
  assert.equal(signal.tailSignals.unclosedToolUse, true);
  assert.equal(signal.tailSignals.trailingRealUser, false);
});

test('claude parse: corrupt lines are skipped, file still parses', async () => {
  const refs = await listClaudeTranscripts(HOME);
  const ref = refs.find((r) => r.filePath.includes(SID_NOISE));
  const signal = await parseClaudeTranscript(ref);
  assert.equal(signal.nativeSessionId, SID_NOISE);
  // 2 message lines, seen once in the head window and once in the tail.
  assert.equal(signal.tailSignals.messagesSeen, 4);
});

test('isSyntheticClaudeUserLine: all synthetic shapes', () => {
  const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
  assert.equal(isSyntheticClaudeUserLine(user('real question')), false);
  assert.equal(isSyntheticClaudeUserLine(user('anything', { isMeta: true })), true);
  assert.equal(
    isSyntheticClaudeUserLine(user([{ type: 'tool_result', tool_use_id: 'x', content: 'y' }])),
    true,
  );
  assert.equal(isSyntheticClaudeUserLine(user('<local-command-stdout>out</local-command-stdout>')), true);
  assert.equal(isSyntheticClaudeUserLine(user('<command-name>/status</command-name>')), true);
  assert.equal(isSyntheticClaudeUserLine(user('<bash-input>ls</bash-input>')), true);
  assert.equal(isSyntheticClaudeUserLine(user('<local-command-caveat>c</local-command-caveat>')), true);
  // Mixed text + tool_result blocks still carry human text → real.
  assert.equal(
    isSyntheticClaudeUserLine(user([{ type: 'text', text: 'also this' }, { type: 'tool_result', tool_use_id: 'x' }])),
    false,
  );
});

test('analyzeClaudeTail: trailing real user sets the Thinking input', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'what about edge cases?' } }),
  ];
  const tail = analyzeClaudeTail(lines);
  assert.equal(tail.trailingRealUser, true);
  assert.equal(tail.unclosedToolUse, false);
});

// ---------------------------------------------------------------------------
// Codex rollouts
// ---------------------------------------------------------------------------

test('listCodexRollouts: walks the YYYY/MM/DD tree', async () => {
  const refs = await listCodexRollouts(HOME);
  assert.equal(refs.length, 3);
});

test('codex meta: first line only, exec detection from source', async () => {
  const refs = await listCodexRollouts(HOME);
  const execRef = refs.find((r) => r.filePath.includes(CODEX_EXEC_DONE));
  const meta = await readCodexMeta(execRef.filePath);
  assert.equal(meta.sessionId, CODEX_EXEC_DONE);
  assert.equal(meta.cwd, '/Users/test/work/project-gamma');
  assert.equal(meta.isExec, true);
  const interactiveRef = refs.find((r) => r.filePath.includes(CODEX_PENDING));
  const interactive = await readCodexMeta(interactiveRef.filePath);
  assert.equal(interactive.isExec, false);
});

test('codex tail: function_call pairs by call_id, pending stays open', async () => {
  const refs = await listCodexRollouts(HOME);
  const index = await loadCodexSessionIndex(HOME);
  const pending = await parseCodexRollout(refs.find((r) => r.filePath.includes(CODEX_PENDING)), index);
  assert.equal(pending.tailSignals.pendingFunctionCalls, 1);
  const done = await parseCodexRollout(refs.find((r) => r.filePath.includes(CODEX_EXEC_DONE)), index);
  assert.equal(done.tailSignals.pendingFunctionCalls, 0);
  assert.equal(done.tailSignals.sawTaskComplete, true);
  assert.equal(done.tailSignals.isExec, true);
});

test('codex tail: agent_message clears generating, corrupt line skipped', async () => {
  const refs = await listCodexRollouts(HOME);
  const waiting = await parseCodexRollout(
    refs.find((r) => r.filePath.includes(CODEX_WAITING)),
    new Map(),
  );
  assert.equal(waiting.tailSignals.generating, false);
  assert.equal(waiting.tailSignals.turnCount, 1);
  assert.equal(waiting.tailSignals.sawTaskComplete, true);
});

test('codex event machine: user_message sets generating', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
  ];
  assert.equal(analyzeCodexTail(lines).generating, true);
});

test('session_index: latest updated_at wins, numeric epoch tolerated', async () => {
  const index = await loadCodexSessionIndex(HOME);
  assert.equal(index.get(CODEX_PENDING), 'Investigate flaky tests (npm test)');
  assert.equal(index.get(CODEX_EXEC_DONE), 'One-shot changelog');
  assert.equal(index.has(CODEX_WAITING), false);
});

// ---------------------------------------------------------------------------
// Line cap
// ---------------------------------------------------------------------------

test('10MB line cap: oversized lines are rejected before JSON.parse', () => {
  const huge = `{"type":"user","pad":"${'x'.repeat(MAX_LINE_BYTES)}"}`;
  assert.ok(huge.length > MAX_LINE_BYTES);
  assert.equal(parseJsonLine(huge), null);
  assert.equal(parseJsonLine('{"ok":true}') !== null, true);
  assert.equal(parseJsonLine('not json'), null);
});
