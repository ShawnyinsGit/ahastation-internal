import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CPU_EXECUTING_THRESHOLD,
  CODEX_DONE_WINDOW_MS,
  inferClaudeState,
  inferCodexState,
} from '../dist-electron/observe/state-machine.js';

const claudeTail = (overrides = {}) => ({
  kind: 'claude',
  trailingRealUser: false,
  unclosedToolUse: false,
  messagesSeen: 4,
  ...overrides,
});

const codexTail = (overrides = {}) => ({
  kind: 'codex',
  generating: false,
  pendingFunctionCalls: 0,
  sawTaskComplete: false,
  isExec: false,
  turnCount: 1,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

test('claude: descendant CPU above threshold → Executing', () => {
  const state = inferClaudeState({
    tail: claudeTail(),
    descendantCpuMax: CPU_EXECUTING_THRESHOLD + 0.5,
    pidState: 'live',
  });
  assert.deepEqual(state, { state: 'active', activity: 'executing' });
});

test('claude: unclosed trailing tool_use → Executing even at 0% CPU', () => {
  const state = inferClaudeState({
    tail: claudeTail({ unclosedToolUse: true }),
    descendantCpuMax: 0,
    pidState: 'live',
  });
  assert.deepEqual(state, { state: 'active', activity: 'executing' });
});

test('claude: trailing real user without assistant reply → Thinking', () => {
  const state = inferClaudeState({
    tail: claudeTail({ trailingRealUser: true }),
    descendantCpuMax: 0,
    pidState: 'live',
  });
  assert.deepEqual(state, { state: 'active', activity: 'thinking' });
});

test('claude: synthetic-only tail on a live process → Waiting (not Thinking)', () => {
  const state = inferClaudeState({
    tail: claudeTail(),
    descendantCpuMax: 0,
    pidState: 'live',
  });
  assert.deepEqual(state, { state: 'waiting', activity: 'waiting' });
});

test('claude: dead pid → session disappears (null)', () => {
  const state = inferClaudeState({
    tail: claudeTail({ unclosedToolUse: true, trailingRealUser: true }),
    descendantCpuMax: 50,
    pidState: 'dead',
  });
  assert.equal(state, null);
});

test('claude: file-only evidence → unknown, never active', () => {
  const state = inferClaudeState({
    tail: claudeTail({ trailingRealUser: true, unclosedToolUse: true }),
    descendantCpuMax: 0,
    pidState: 'none',
  });
  assert.deepEqual(state, { state: 'unknown', activity: 'unknown' });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test('codex: exec session with task_complete → done', () => {
  const state = inferCodexState({
    tail: codexTail({ isExec: true, sawTaskComplete: true }),
    descendantCpuMax: 0,
    pidState: 'live',
    mtimeMs: 1_000,
    now: 1_000,
  });
  assert.deepEqual(state, { state: 'done', activity: 'unknown' });
});

test('codex: interactive task_complete is NOT done', () => {
  const state = inferCodexState({
    tail: codexTail({ isExec: false, sawTaskComplete: true }),
    descendantCpuMax: 0,
    pidState: 'live',
    mtimeMs: 1_000,
    now: 1_000,
  });
  assert.deepEqual(state, { state: 'waiting', activity: 'waiting' });
});

test('codex: unclaimed inside the done window → done; outside → idle', () => {
  const now = 10_000_000;
  const fresh = inferCodexState({
    tail: codexTail(),
    descendantCpuMax: 0,
    pidState: 'none',
    mtimeMs: now - CODEX_DONE_WINDOW_MS + 1_000,
    now,
  });
  assert.equal(fresh.state, 'done');
  const stale = inferCodexState({
    tail: codexTail(),
    descendantCpuMax: 0,
    pidState: 'none',
    mtimeMs: now - CODEX_DONE_WINDOW_MS - 60_000,
    now,
  });
  assert.equal(stale.state, 'idle');
});

test('codex: live process — cpu/pending → Executing, generating → Thinking', () => {
  const base = { mtimeMs: 0, now: 0, pidState: 'live' };
  assert.deepEqual(
    inferCodexState({ tail: codexTail({ pendingFunctionCalls: 2 }), descendantCpuMax: 0, ...base }),
    { state: 'active', activity: 'executing' },
  );
  assert.deepEqual(
    inferCodexState({ tail: codexTail(), descendantCpuMax: 9.9, ...base }),
    { state: 'active', activity: 'executing' },
  );
  assert.deepEqual(
    inferCodexState({ tail: codexTail({ generating: true }), descendantCpuMax: 0, ...base }),
    { state: 'active', activity: 'thinking' },
  );
});
