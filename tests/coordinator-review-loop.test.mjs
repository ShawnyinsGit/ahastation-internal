// The Coordinator review used to be a single fire-and-forget briefing: nothing
// in production ever called onCoordinatorTurnEnded, so a Coordinator that read
// two chunks and moved on left the delivery — and everything depending on it —
// stalled forever. These tests pin the loop that now drives the review to a
// terminal state, and the tool gate that keeps the Coordinator on task.
//
// Run after `npm run build:electron`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Orchestrator } from '../dist-electron/orchestrator.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';
import { gateDuringCoordinatorReview } from '../dist-electron/meeting-mcp.js';

class FakeSession {
  constructor(options = {}) {
    this.options = options;
    this.started = false;
    this.ended = false;
    this.inputs = [];
    this.cwd = options.cwd;
  }
  start() { this.started = true; }
  sendUserText(text) { this.inputs.push(text); }
  sendUserContent() { /* no-op */ }
  resolvePermission() { /* no-op */ }
  async interrupt() { /* no-op */ }
  async setPermissionMode() { /* no-op */ }
  setAutoApprove() { /* no-op */ }
  end() { this.ended = true; }
  /** Simulate a provider turn boundary for this host. */
  endTurn() {
    this.options.emit?.({ kind: 'message', message: { type: 'result' } });
  }
  briefings() {
    return this.inputs.filter((text) => text.startsWith('(coordinator review)'));
  }
}

function createGitWorkspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'ahastation-review-loop-'));
  const git = (args) => execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  git(['init']);
  git(['config', 'user.email', 'review-loop-test@ahastation.local']);
  git(['config', 'user.name', 'AhaStation review loop test']);
  git(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(root, 'README.md'), '# review loop fixture\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

async function waitUntil(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test('an unfinished Coordinator turn re-briefs the review instead of stalling the delivery', async (t) => {
  const root = createGitWorkspace(t);
  const meetingId = `review-loop-${Date.now()}`;
  const sessions = [];
  const orch = new Orchestrator({
    emit: () => {},
    cwd: root,
    meetingId,
    reviewStallTimeoutMs: 0,
    workspaceManager: new TaskWorkspaceManager(meetingId, root, {
      worktreeRoot: join(root, '.task-worktrees'),
    }),
    sessionFactory: (options) => {
      const session = new FakeSession(options);
      sessions.push(session);
      return session;
    },
  });
  t.after(() => orch.end().catch(() => undefined));

  await orch.start();
  const coordinator = sessions[0];
  assert.ok(coordinator, 'coordinator host session was not created');

  assert.equal((await orch.installPlan([
    { id: 'a', title: 'A', prompt: 'do A', deps: [], writePaths: ['result.txt'] },
  ])).ok, true);
  const worker = await waitUntil(() => sessions[1], 'worker session was not created');

  writeFileSync(join(worker.cwd, 'result.txt'), 'finished with evidence\n');
  orch.submitWorkerReport('a', {
    status: 'completed',
    summary: 'finished with evidence',
    files: [{ path: 'result.txt', action: 'created' }],
    tests: [],
    unresolved: [],
  });

  await waitUntil(() => coordinator.briefings().length >= 1, 'Coordinator never received a review briefing');
  const first = JSON.parse(coordinator.briefings()[0].split('\n')[1]);
  assert.equal(first.status, 'active');
  assert.ok(first.uncoveredChunkIds.length > 0, 'briefing must name the chunks still owed a verdict');
  assert.match(first.nextAction, /submit_delivery_chunk_review/);

  const gate = orch.activeReviewGate();
  assert.equal(gate.reviewId, first.reviewId);
  assert.deepEqual(gate.uncoveredChunkIds, first.uncoveredChunkIds);

  // The Coordinator ends its turn without covering anything: the delivery must
  // not be abandoned in `coordinator-reviewing`.
  coordinator.endTurn();
  await waitUntil(
    () => coordinator.briefings().length >= 2,
    'an unfinished Coordinator turn did not re-brief the review',
  );
  assert.equal(orch.inspectDeliveryReview(first.reviewId).turnCount, 1);

  for (;;) {
    const chunk = orch.getDeliveryReviewChunk(first.reviewId);
    if (!chunk) break;
    await orch.submitDeliveryChunkReview(first.reviewId, {
      chunkId: chunk.id,
      chunkHash: chunk.hash,
      verdict: 'passed',
      findings: [],
    });
  }
  assert.equal(
    orch.inspectDeliveryReview(first.reviewId).turnCount,
    0,
    'covering a chunk must clear the stall counter',
  );
  await orch.completeDeliveryReview(first.reviewId);

  assert.equal(orch.activeReviewGate(), null);
  const settled = coordinator.briefings().length;
  coordinator.endTurn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(coordinator.briefings().length, settled, 'a completed review must stop re-briefing');
});

test('review mode refuses every non-review Coordinator tool with the uncovered chunks', async () => {
  const bridge = {
    activeReviewGate: () => ({
      reviewId: 'review-1',
      deliveryId: 'delivery-1',
      uncoveredChunkIds: ['chunk-2', 'chunk-3'],
      remainingChunks: 2,
    }),
  };
  const calls = [];
  const [planning, reviewing] = gateDuringCoordinatorReview(bridge, [
    {
      name: 'plan_meeting',
      handler: async () => {
        calls.push('plan_meeting');
        return { content: [{ type: 'text', text: 'planned' }] };
      },
    },
    {
      name: 'submit_delivery_chunk_review',
      handler: async () => {
        calls.push('submit_delivery_chunk_review');
        return { content: [{ type: 'text', text: 'submitted' }] };
      },
    },
  ]);

  const refused = await planning.handler({});
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /review-1/);
  assert.match(refused.content[0].text, /chunk-2, chunk-3/);

  const allowed = await reviewing.handler({});
  assert.equal(allowed.content[0].text, 'submitted');
  assert.deepEqual(calls, ['submit_delivery_chunk_review']);
});

test('the tool gate lifts as soon as no review is owed', async () => {
  const bridge = { activeReviewGate: () => null };
  const [planning] = gateDuringCoordinatorReview(bridge, [{
    name: 'plan_meeting',
    handler: async () => ({ content: [{ type: 'text', text: 'planned' }] }),
  }]);
  const result = await planning.handler({});
  assert.equal(result.content[0].text, 'planned');
});
