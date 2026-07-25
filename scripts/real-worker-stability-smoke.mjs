// Opt-in release evidence for exact, authenticated Claude Code and Codex
// Worker runtimes. This intentionally performs real model/tool turns in
// disposable Git repositories.
//
// PowerShell:
//   $env:AHASTATION_REAL_WORKER_SMOKE='1'
//   node scripts/real-worker-stability-smoke.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';

if (process.env.AHASTATION_REAL_WORKER_SMOKE !== '1') {
  console.log('SKIP  set AHASTATION_REAL_WORKER_SMOKE=1 to run paid real Worker smoke');
  process.exit(0);
}

register('../tests/electron-stub.mjs', import.meta.url);

const [
  { getBackendRegistry, resetBackendRegistry },
  { MeetingRepository },
  { Orchestrator },
  { TaskWorkspaceManager },
  { probeWorkerRuntimeVersion },
] = await Promise.all([
  import('../dist-electron/backends/registry.js'),
  import('../dist-electron/meeting-repository.js'),
  import('../dist-electron/orchestrator.js'),
  import('../dist-electron/task-workspace.js'),
  import('../dist-electron/backends/worker-runtime-contract.js'),
]);

const NODE = process.execPath;
const EXACT_RUNTIME_VERSIONS = {
  'claude-code': '2.1.150',
  codex: '0.144.1',
};
const SELECTED_BACKENDS = (process.env.AHASTATION_REAL_WORKER_BACKENDS ?? 'claude-code,codex')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepository(backendId) {
  const root = mkdtempSync(join(tmpdir(), `ahastation-real-${backendId}-`));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'real-smoke@ahastation.local']);
  git(root, ['config', 'user.name', 'AhaStation Real Smoke']);
  git(root, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(root, 'README.md'), '# Real Worker smoke\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return { root, revision: git(root, ['rev-parse', 'HEAD']) };
}

async function waitFor(predicate, message, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.fail(message);
}

/**
 * Release evidence must prove the Coordinator model closes the review itself.
 * This script deliberately never calls submitDeliveryChunkReview or
 * completeDeliveryReview: a meeting that cannot finish its own review has to
 * fail the gate rather than have the harness stamp the verdict for it.
 */
async function assertReviewsAreNotStalled(orchestrator, meetingId) {
  const journal = await MeetingRepository.replay(meetingId);
  for (const request of journal.filter((event) => event.type === 'coordinator-review-requested')) {
    const reviewId = request.payload?.data?.session?.id;
    if (!reviewId) continue;
    const session = orchestrator.inspectDeliveryReview(reviewId);
    if (session.status === 'paused') {
      assert.fail(
        `Coordinator review ${reviewId} stalled (${session.pauseReason}) with `
        + `${session.coverage.totalChunks - session.coverage.reviewedChunks} chunk(s) uncovered`,
      );
    }
    for (const chunk of session.chunkEvidence ?? []) {
      assert.equal(
        chunk.requiresUserConfirmation,
        false,
        `real smoke produced withheld evidence for ${chunk.path}`,
      );
    }
  }
}

/** Tool names the Coordinator host actually invoked, read off its own turns. */
function coordinatorToolNames(events) {
  const names = new Set();
  for (const entry of events) {
    if (entry.source !== 'talker' || entry.event?.kind !== 'message') continue;
    const content = entry.event.message?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') names.add(block.name);
    }
  }
  return names;
}

async function runBackend(backendId) {
  assert.ok(
    Object.hasOwn(EXACT_RUNTIME_VERSIONS, backendId),
    `unsupported real smoke backend: ${backendId}`,
  );
  resetBackendRegistry();
  const registry = getBackendRegistry();
  const backend = registry.get(backendId);
  assert.ok(backend?.capabilities.executeTasks, `${backendId} Worker is disabled`);
  const binary = backend.resolveBinary();
  assert.ok(binary, `${backendId} exact runtime is unavailable`);
  const runtimeVersion = probeWorkerRuntimeVersion(backendId, binary);
  assert.equal(runtimeVersion, EXACT_RUNTIME_VERSIONS[backendId]);
  const probe = await registry.probe(backendId, { authMode: 'none' });
  assert.equal(probe.auth, 'ready', `${backendId} authentication is not ready`);

  const repo = createRepository(backendId);
  const meetingId = `real-worker-${backendId}-${randomUUID()}`;
  const taskId = `real-${backendId}`;
  const outputPath = `smoke/${backendId}.txt`;
  const sentinel = `AhaStation real ${backendId} ${meetingId}`;
  const taskWorktreeRoot = join(tmpdir(), 'ahastation-real-worker-worktrees', meetingId);
  const integrationWorktree = join(
    homedir(),
    '.ahastation',
    'integration-worktrees',
    meetingId,
  );
  const rendererEvents = [];
  let orchestrator;
  let permissionAsked = false;
  let steerResult = null;
  let steeringStarted = false;

  try {
    orchestrator = new Orchestrator({
      meetingId,
      cwd: repo.root,
      defaultBackendId: 'claude-code',
      workspaceManager: new TaskWorkspaceManager(meetingId, repo.root, {
        worktreeRoot: taskWorktreeRoot,
      }),
      emit(event) {
        rendererEvents.push(event);
        if (
          event.event?.kind === 'permission-request'
          && event.source === taskId
        ) {
          permissionAsked = true;
          queueMicrotask(() => {
            orchestrator.resolvePermission(
              event.event.id,
              'allow',
              'Real Worker smoke user approval.',
            );
          });
        }
        const workerEvent = event.event?.kind === 'worker-event'
          ? event.event.event
          : null;
        if (
          !steeringStarted
          && workerEvent?.workerId === taskId
          && (workerEvent.payload?.kind === 'progress' || workerEvent.payload?.kind === 'tool')
        ) {
          steeringStarted = true;
          queueMicrotask(async () => {
            steerResult = await orchestrator.steerWorker(
              taskId,
              `Continue the same task and preserve the exact sentinel: ${sentinel}`,
            );
          });
        }
      },
    });

    await orchestrator.start(
      `Coordinate one real ${backendId} Worker smoke without editing files yourself.`,
    );
    const check = [NODE, '-e', 'process.exit(0)'];
    const permissionProbe = [
      'git',
      'push',
      '--force',
      '.',
      'HEAD:refs/heads/real-smoke-permission-probe',
    ];
    const planned = [{
      id: taskId,
      title: `Real ${backendId} Worker smoke`,
      prompt: [
        'Work only in the assigned task worktree.',
        'Before editing, you MUST invoke the command tool exactly once with this argv:',
        JSON.stringify(permissionProbe),
        'This force-push targets only the disposable local smoke repository and exists to exercise the real high-risk user permission bridge. Wait for approval, then continue.',
        `Then you MUST call the meeting-worker ask_coordinator tool exactly once with this question: Real canonical permission probe: ${sentinel}`,
        'That task-scoped message is a protocol probe. Continue the task after the tool reports that it was queued; do not wait for a reply.',
        'Run `git status --short` once; if approval is requested, wait for it.',
        `Create ${outputPath} containing exactly this single line: ${sentinel}`,
        'Then submit one valid complete WorkReport listing that file, the approved permission probe, and the actual git status check.',
      ].join('\n'),
      deps: [],
      executorBackendId: backendId,
      writePaths: ['smoke'],
      executionProfile: {
        schemaVersion: 1,
        backendId,
        workMode: 'balanced',
        contextMode: 'meeting-summary',
        timeoutMs: 240_000,
        maxTokenBudget: 40_000,
      },
      contextSelection: {
        mode: 'meeting-summary',
        messageIds: [],
        decisionIds: [],
        dependencyTaskIds: [],
        attachmentIds: [],
      },
      workspaceMode: 'git-worktree',
      authorityRequest: {
        writePaths: ['smoke'],
        toolKinds: ['read', 'write', 'command'],
        workingDirectories: ['.'],
        commands: [check, permissionProbe],
        environmentKeys: [],
        maxCommandTimeoutMs: 120_000,
        networkHosts: [],
      },
      acceptanceCriteria: [{
        id: 'real-smoke-check',
        description: 'The deterministic post-Worker validation command passes.',
        verification: { kind: 'command', argv: check, timeoutMs: 10_000 },
      }],
    }];
    assert.deepEqual(await orchestrator.proposePlan(planned), { ok: true });
    assert.deepEqual(await orchestrator.approvePendingPlan(true, planned), { ok: true });

    await waitFor(
      () => rendererEvents.some((entry) => (
        entry.event?.kind === 'worker-spawned' && entry.event.workerId === taskId
      )),
      `${backendId} Worker did not spawn`,
    );
    await waitFor(
      async () => {
        await assertReviewsAreNotStalled(orchestrator, meetingId);
        const source = await orchestrator.getTaskInspectorSource(taskId);
        if (source?.task.status === 'failed') {
          assert.fail(
            `${backendId} Worker failed before acceptance: ${source.task.summary ?? 'unknown failure'}`,
          );
        }
        return source?.task.status === 'accepted' ? source : null;
      },
      `${backendId} Worker did not produce, verify, review, and integrate a WorkReport`,
    );
    await waitFor(() => steerResult, `${backendId} Worker steering was never exercised`);
    assert.equal(steerResult.ok, true);
    assert.equal(steerResult.queued, false, `${backendId} Worker steering was not delivered live`);
    assert.equal(permissionAsked, true, `${backendId} did not exercise the user permission bridge`);
    assert.equal(
      git(repo.root, ['rev-parse', 'HEAD']),
      repo.revision,
      'per-task integration changed the user base before final acceptance',
    );

    const delivery = await waitFor(
      () => orchestrator.prepareFinalMeetingDelivery(),
      `${backendId} final Meeting delivery was not prepared`,
    );
    const published = await orchestrator.acceptMeetingDelivery(delivery.id, delivery.contentHash);
    assert.equal(published.publicationState, 'published');
    assert.equal(git(repo.root, ['rev-parse', 'HEAD']), delivery.integrationHead);
    const output = readFileSync(join(repo.root, outputPath), 'utf8');
    assert.equal(
      output === sentinel || output === `${sentinel}\n`,
      true,
      'Worker output must contain exactly the sentinel with at most one trailing newline',
    );

    await orchestrator.snapshotActiveMeeting();
    const journal = await MeetingRepository.replay(meetingId);
    assert.equal(journal.some((event) => (
      event.type === 'event:worker-event'
      && event.payload?.event?.event?.backendId === backendId
      && event.payload?.event?.event?.payload?.kind === 'delivery'
    )), true);
    // High-risk confirmation itself must journal a Backend-scoped safeInput.
    // Codex may complete writes via app-server file-change events without a
    // second auto-allow decision, so do not require an extra allow entry.
    assert.equal(journal.some((event) => (
      event.type === 'task-permission-decided'
      && event.payload?.taskId === taskId
      && event.payload?.data?.decision === 'ask-user'
      && event.payload?.data?.safeInput?.backendId === backendId
    )), true, `${backendId} high-risk ask-user lacked canonical Backend safeInput`);
    assert.equal(journal.some((event) => (
      event.type === 'task-message-enqueued'
      && event.payload?.taskId === taskId
      && event.payload?.data?.kind === 'steer'
    )), true);
    assert.equal(journal.some((event) => (
      event.type === 'task-message-delivered'
      && event.payload?.taskId === taskId
    )), true);
    assert.equal(journal.some((event) => (
      event.type === 'task-message-acknowledged'
      && event.payload?.taskId === taskId
    )), true);
    assert.equal(
      journal.filter((event) => event.type === 'meeting-publication-completed').length,
      1,
    );

    // The review must have been closed by the Coordinator model, not by this
    // harness. Journal coverage proves it finished; the Coordinator's own
    // tool_use blocks prove the verdicts came from the meeting.
    assert.equal(journal.some((event) => (
      event.type === 'coordinator-review-chunk-submitted'
      && event.payload?.data?.session?.reviews?.some((review) => review.reviewer === 'coordinator')
    )), true, `${backendId} review produced no Coordinator chunk verdict`);
    assert.equal(journal.some((event) => (
      event.type === 'coordinator-review-completed'
      && event.payload?.data?.session?.coverage?.complete === true
    )), true, `${backendId} review never reached complete hash-bound coverage`);
    const toolNames = [...coordinatorToolNames(rendererEvents)];
    assert.equal(
      toolNames.some((name) => name.endsWith('submit_delivery_chunk_review')),
      true,
      `${backendId} Coordinator never called submit_delivery_chunk_review itself`,
    );
    assert.equal(
      toolNames.some((name) => name.endsWith('complete_delivery_review')),
      true,
      `${backendId} Coordinator never called complete_delivery_review itself`,
    );

    return {
      schemaVersion: 1,
      kind: 'real-backend-smoke',
      backendId,
      runtimeVersion,
      runId: meetingId,
      verifiedAt: new Date().toISOString(),
      checks: [
        'work-report',
        'interrupt',
        'resume',
        'permission-bridge',
        'canonical-permission-normalization',
        'coordinator-driven-review',
        'recovery',
      ],
    };
  } finally {
    if (orchestrator) await orchestrator.end().catch(() => undefined);
    if (existsSync(integrationWorktree)) {
      try {
        git(repo.root, ['worktree', 'remove', '--force', integrationWorktree]);
      } catch {}
    }
    try { git(repo.root, ['worktree', 'prune']); } catch {}
    for (const target of [taskWorktreeRoot, repo.root]) {
      try {
        rmSync(target, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      } catch (error) {
        console.warn(
          `WARN  real smoke cleanup deferred for ${target}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

const evidence = [];
for (const backendId of SELECTED_BACKENDS) {
  console.log(`RUN   ${backendId} exact authenticated Worker vertical smoke`);
  evidence.push(await runBackend(backendId));
  console.log(`PASS  ${backendId}`);
}
console.log(JSON.stringify({ schemaVersion: 1, evidence }, null, 2));
