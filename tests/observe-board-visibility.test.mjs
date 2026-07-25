import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boardableObservedSessions,
  compareBoardableObserved,
  isBoardableObserved,
  OBSERVED_DONE_WINDOW_MS,
} from '../dist-electron/observe/board-visibility.js';

const NOW = 1_800_000_000_000;

/** Minimal ObservedSession — the helper only reads these fields. */
const session = (overrides = {}) => ({
  id: 'obs-1',
  clientKind: 'claude-code',
  nativeSessionId: 'native-1',
  projectId: 'proj-1',
  projectName: 'demo',
  cwd: '/tmp/demo',
  title: 'a session',
  state: 'active',
  activity: 'thinking',
  inferred: true,
  lastActiveAt: NOW,
  titleSource: 'first-prompt',
  isNoise: false,
  evidence: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Visibility rule (mirror of the board's columnForObserved + noise exclusion)
// ---------------------------------------------------------------------------

test('waiting and active are always boardable', () => {
  assert.equal(isBoardableObserved(session({ state: 'waiting' }), NOW), true);
  assert.equal(isBoardableObserved(session({ state: 'active' }), NOW), true);
});

test('done is boardable only inside the recent window', () => {
  const recent = session({ state: 'done', lastActiveAt: NOW - OBSERVED_DONE_WINDOW_MS + 1 });
  const edge = session({ state: 'done', lastActiveAt: NOW - OBSERVED_DONE_WINDOW_MS });
  const stale = session({ state: 'done', lastActiveAt: NOW - OBSERVED_DONE_WINDOW_MS - 1 });
  assert.equal(isBoardableObserved(recent, NOW), true);
  assert.equal(isBoardableObserved(edge, NOW), true);
  assert.equal(isBoardableObserved(stale, NOW), false);
});

test('idle is boardable only when backed by a live process (pid set)', () => {
  assert.equal(isBoardableObserved(session({ state: 'idle', pid: 4242 }), NOW), true);
  assert.equal(isBoardableObserved(session({ state: 'idle' }), NOW), false);
});

test('unknown never shows', () => {
  assert.equal(isBoardableObserved(session({ state: 'unknown', pid: 1 }), NOW), false);
});

test('noise is excluded regardless of state', () => {
  assert.equal(isBoardableObserved(session({ state: 'waiting', isNoise: true }), NOW), false);
  assert.equal(isBoardableObserved(session({ state: 'active', isNoise: true, pid: 1 }), NOW), false);
});

// ---------------------------------------------------------------------------
// Ordering: waiting first, then lastActiveAt desc
// ---------------------------------------------------------------------------

test('compare: waiting outranks everything, then recency desc', () => {
  const oldWaiting = session({ id: 'w', state: 'waiting', lastActiveAt: NOW - 60_000 });
  const freshActive = session({ id: 'a', state: 'active', lastActiveAt: NOW });
  const staleActive = session({ id: 'b', state: 'active', lastActiveAt: NOW - 30_000 });
  assert.ok(compareBoardableObserved(oldWaiting, freshActive) < 0);
  assert.ok(compareBoardableObserved(freshActive, oldWaiting) > 0);
  assert.ok(compareBoardableObserved(freshActive, staleActive) < 0);
  assert.ok(compareBoardableObserved(staleActive, freshActive) > 0);
});

test('boardableObservedSessions filters and sorts the mixed list', () => {
  const sessions = [
    session({ id: 'unknown', state: 'unknown' }),
    session({ id: 'stale-done', state: 'done', lastActiveAt: NOW - OBSERVED_DONE_WINDOW_MS - 1 }),
    session({ id: 'file-idle', state: 'idle' }),
    session({ id: 'noise', state: 'active', isNoise: true }),
    session({ id: 'active', state: 'active', lastActiveAt: NOW - 5_000 }),
    session({ id: 'recent-done', state: 'done', lastActiveAt: NOW - 1_000 }),
    session({ id: 'live-idle', state: 'idle', pid: 99, lastActiveAt: NOW - 10_000 }),
    session({ id: 'waiting', state: 'waiting', lastActiveAt: NOW - 120_000 }),
  ];
  const out = boardableObservedSessions(sessions, NOW);
  assert.deepEqual(
    out.map((s) => s.id),
    ['waiting', 'recent-done', 'active', 'live-idle'],
  );
});

test('boardableObservedSessions does not mutate the input array', () => {
  const sessions = [
    session({ id: 'b', state: 'active', lastActiveAt: NOW - 5_000 }),
    session({ id: 'a', state: 'waiting', lastActiveAt: NOW }),
  ];
  const before = sessions.map((s) => s.id);
  boardableObservedSessions(sessions, NOW);
  assert.deepEqual(sessions.map((s) => s.id), before);
});
