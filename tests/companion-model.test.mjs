import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignSeats,
  bubbleVisible,
  buildAggregate,
  CompanionModel,
  phraseForTool,
  pushBubble,
  reduceParticipant,
  truncateBubble,
  BUBBLE_MAX_LEN,
  BUBBLE_TTL_MS,
  COMPANION_MAX_SEATS,
} from '../dist-electron/companion/companion-model.js';

// ---------------------------------------------------------------------------
// Seats: fixed 6 slots; join = sit, leave = dusty desk, overflow = standing
// ---------------------------------------------------------------------------

test('assignSeats: previous seats kept, new hosts take lowest free slot', () => {
  const prev = new Map([['a', 2]]);
  const out = assignSeats(['a', 'b', 'c'], prev);
  assert.equal(out.find((a) => a.hostId === 'a').seat, 2);
  assert.equal(out.find((a) => a.hostId === 'b').seat, 0);
  assert.equal(out.find((a) => a.hostId === 'c').seat, 1);
  assert.ok(out.every((a) => !a.vacated));
});

test('assignSeats: absent previous host leaves a dusty vacant desk', () => {
  const prev = new Map([['ghost', 4]]);
  const out = assignSeats(['a'], prev);
  const dusty = out.find((a) => a.hostId === 'ghost');
  assert.equal(dusty.seat, 4);
  assert.equal(dusty.vacated, true);
});

test('assignSeats: overflow beyond 6 seats goes standing', () => {
  const ids = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'];
  const out = assignSeats(ids, new Map());
  const standing = out.filter((a) => a.seat === 'standing');
  assert.equal(standing.length, ids.length - COMPANION_MAX_SEATS);
  assert.deepEqual(
    out.slice(0, COMPANION_MAX_SEATS).map((a) => a.seat).sort(),
    [0, 1, 2, 3, 4, 5],
  );
});

// ---------------------------------------------------------------------------
// Bubble rules: ≤40 hard cut / replace + ×N / ≤8s TTL / phrase templates
// ---------------------------------------------------------------------------

test('truncateBubble: flattens whitespace, hard-cuts with ellipsis tail', () => {
  assert.equal(truncateBubble('short'), 'short');
  assert.equal(truncateBubble('a\nb\tc'), 'a b c');
  const long = 'x'.repeat(BUBBLE_MAX_LEN + 20);
  const out = truncateBubble(long);
  assert.equal(out.length, BUBBLE_MAX_LEN);
  assert.ok(out.endsWith('…'));
});

test('pushBubble: new text replaces old and bumps backlog count within TTL', () => {
  const first = pushBubble(null, 'one', 1000);
  assert.deepEqual(first, { text: 'one', startedAt: 1000, count: 1 });
  const second = pushBubble(first, 'two', 1000 + BUBBLE_TTL_MS - 1);
  assert.deepEqual(second, { text: 'two', startedAt: 1000 + BUBBLE_TTL_MS - 1, count: 2 });
  // Now measured from the SECOND bubble's start: past its TTL → fresh count.
  const fresh = pushBubble(second, 'three', second.startedAt + BUBBLE_TTL_MS + 1);
  assert.equal(fresh.count, 1);
});

test('bubbleVisible: bubble dies after its TTL', () => {
  const b = pushBubble(null, 'hi', 10_000);
  assert.equal(bubbleVisible(b, 10_000 + BUBBLE_TTL_MS), b);
  assert.equal(bubbleVisible(b, 10_000 + BUBBLE_TTL_MS + 1), null);
});

test('phraseForTool: fixed templates, file name extracted, unknown falls back', () => {
  assert.equal(phraseForTool('Edit', { file_path: '/repo/src/auth.ts' }), '正在编辑 auth.ts');
  assert.equal(phraseForTool('Edit', {}), '正在编辑文件');
  assert.equal(phraseForTool('Bash', { command: 'rm -rf /' }), '正在跑命令');
  assert.equal(phraseForTool('Frobnicate', {}), '正在用 Frobnicate');
});

// ---------------------------------------------------------------------------
// Participant status machine
// ---------------------------------------------------------------------------

const baseP = {
  hostId: 'h1',
  backendId: 'kimi',
  seat: 0,
  vacated: false,
  status: 'idle',
  statusChangedAt: 0,
  bubble: null,
  pendingPermission: false,
};

test('reduceParticipant: text/tool → working + bubble; idle-signal → idle', () => {
  const working = reduceParticipant(baseP, { kind: 'text', hostId: 'h1', text: '你好' }, 100);
  assert.equal(working.status, 'working');
  assert.equal(working.bubble.text, '你好');
  const idle = reduceParticipant(working, { kind: 'idle-signal', hostId: 'h1' }, 200);
  assert.equal(idle.status, 'idle');
});

test('reduceParticipant: permission-pending → alert + pending; cleared → idle', () => {
  const pending = reduceParticipant(baseP, { kind: 'permission-pending', hostId: 'h1' }, 100);
  assert.equal(pending.status, 'alert');
  assert.equal(pending.pendingPermission, true);
  assert.equal(pending.bubble.text, '等待审批');
  const cleared = reduceParticipant(pending, { kind: 'permission-cleared', hostId: 'h1' }, 200);
  assert.equal(cleared.status, 'idle');
  assert.equal(cleared.pendingPermission, false);
});

test('reduceParticipant: ended done → celebrating, failed → alert', () => {
  assert.equal(reduceParticipant(baseP, { kind: 'ended', hostId: 'h1', status: 'done' }, 1).status, 'celebrating');
  assert.equal(reduceParticipant(baseP, { kind: 'ended', hostId: 'h1', status: 'failed' }, 1).status, 'alert');
  assert.equal(reduceParticipant(baseP, { kind: 'ended', hostId: 'h1', status: 'interrupted' }, 1).status, 'idle');
});

// ---------------------------------------------------------------------------
// Mascot aggregate (level-1 information)
// ---------------------------------------------------------------------------

test('buildAggregate: counts working/stalled/pending, grades alerts, ignores vacated', () => {
  const mk = (over) => ({ ...baseP, ...over });
  const empty = buildAggregate([mk({})]);
  assert.deepEqual(empty, { text: '大家都在空闲', alertLevel: 'none' });

  const agg = buildAggregate([
    mk({ hostId: 'a', status: 'working' }),
    mk({ hostId: 'b', status: 'working' }),
    mk({ hostId: 'c', status: 'stalled' }),
    mk({ hostId: 'd', pendingPermission: true }),
    mk({ hostId: 'e', status: 'working', vacated: true }), // vacated never counts
  ]);
  assert.equal(agg.text, '2 人工作中 · 1 人卡住 · 1 条待审批');
  assert.equal(agg.alertLevel, 'strong');

  const celebrating = buildAggregate([mk({ status: 'celebrating' })]);
  assert.equal(celebrating.alertLevel, 'light');
});

// ---------------------------------------------------------------------------
// CompanionModel integration: roster + ingest + state
// ---------------------------------------------------------------------------

test('CompanionModel: roster assigns seats, events drive statuses, state shapes output', () => {
  const model = new CompanionModel();
  model.setRoster(
    [
      { id: 'coord', backendId: 'claude-code', role: 'coordinator' },
      { id: 'w1', backendId: 'kimi', role: 'worker' },
    ],
    1000,
  );
  model.ingest({ kind: 'tool', hostId: 'w1', toolName: 'Edit', input: { file_path: '/a/b.ts' } }, 1100);
  model.ingest({ kind: 'permission-pending', hostId: 'w1' }, 1200);

  const state = model.state(1300);
  assert.equal(state.participants.length, 2);
  assert.equal(state.mascot.coordinatorHostId, 'coord');
  assert.equal(state.mascot.alertLevel, 'strong');
  const w1 = state.participants.find((p) => p.hostId === 'w1');
  assert.equal(w1.status, 'alert');
  assert.equal(w1.bubble.text, '等待审批');
  assert.equal(state.ttsActive, false);

  // Bubble TTL: far-future state hides the bubble.
  const later = model.state(1300 + BUBBLE_TTL_MS + 1);
  assert.equal(later.participants.find((p) => p.hostId === 'w1').bubble, null);
});
