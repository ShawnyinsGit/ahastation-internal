// Orchestration coverage for the full plan → parallel delivery → review →
// integration → acceptance pipeline.
//
// The Coordinator verdicts here are injected through the orchestrator API, not
// produced by a model. That makes the state machine deterministic, but it means
// this file proves nothing about whether a real Coordinator can finish a review
// on its own. That property is covered by the model-driven loop in
// tests/coordinator-review-loop.test.mjs and by the release gate in
// scripts/real-worker-stability-smoke.mjs, which refuses to submit verdicts for
// the meeting.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import {
  getBackendRegistry,
  resetBackendRegistry,
} from '../dist-electron/backends/registry.js';
import { MeetingRepository } from '../dist-electron/meeting-repository.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import { TaskWorkspaceManager } from '../dist-electron/task-workspace.js';

const NODE = process.execPath;
const REAL_CHECK = [NODE, '-e', 'process.exit(0)'];

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepository() {
  const root = execFileSync(
    process.execPath,
    ['-e', 'console.log(require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(),"ahastation-vertical-")))'],
    { encoding: 'utf8' },
  ).trim();
  git(root, ['init']);
  git(root, ['config', 'user.email', 'vertical@example.com']);
  git(root, ['config', 'user.name', 'Vertical Fixture']);
  git(root, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(root, 'README.md'), '# Collaboration vertical slice\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return { root, revision: git(root, ['rev-parse', 'HEAD']) };
}

async function waitFor(predicate, message, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(message);
}

function wrapBackend(base, backendId, binaryPath, sessions) {
  return {
    id: backendId,
    capabilities: structuredClone(base.capabilities),
    compileTaskProfile: (requested, runtime) => base.compileTaskProfile(requested, runtime),
    normalizePermissionRequest: (request) => base.normalizePermissionRequest(request),
    resolveBinary: () => binaryPath,
    buildEnv: (auth, extra) => base.buildEnv(auth, extra),
    async validateAuth() { return { ok: true }; },
    async checkAuthStatus() { return { loggedIn: true }; },
    createSession(config, emit) {
      const sessionId = `${backendId}-${sessions.length + 1}`;
      const session = {
        backendId,
        config,
        emit,
        inputs: [],
        permissions: [],
        interrupts: [],
        ended: false,
        async start() {},
        end() { this.ended = true; },
        sendUserText(text, priority) { this.inputs.push({ text, priority }); },
        sendUserContent(content, priority) { this.inputs.push({ content, priority }); },
        resolvePermission(id, decision, message) {
          this.permissions.push({ id, decision, message });
        },
        async interrupt(reason) { this.interrupts.push(reason); },
        snapshot() {
          return {
            protocol: backendId === 'codex' ? 'codex-app-server' : 'claude-agent-sdk',
            sessionId,
            backendVersion: backendId === 'codex' ? '0.144.1' : '2.1.150',
          };
        },
      };
      sessions.push(session);
      return session;
    },
  };
}

function task(id, backendId, deps, writePaths, title) {
  return {
    id,
    title,
    prompt: `Execute the deterministic ${id} delivery.`,
    deps,
    executorBackendId: backendId,
    writePaths,
    executionProfile: {
      schemaVersion: 1,
      backendId,
      workMode: 'balanced',
      contextMode: 'meeting-summary',
      timeoutMs: 120_000,
      maxTokenBudget: 20_000,
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
      writePaths,
      toolKinds: ['read', 'write', 'command'],
      workingDirectories: ['.'],
      commands: [REAL_CHECK],
      environmentKeys: [],
      maxCommandTimeoutMs: 120_000,
      networkHosts: [],
    },
    acceptanceCriteria: [{
      id: 'deterministic-check',
      description: 'The deterministic validation command passes.',
      verification: { kind: 'command', argv: REAL_CHECK, timeoutMs: 10_000 },
    }],
  };
}

function taskIdForSession(session, taskIds) {
  if (session.config.executionRole !== 'worker') return null;
  return taskIds.find((taskId) => (
    session.config.cwd.split(/[\\/]/u).some((part) => part.includes(taskId))
  )) ?? null;
}

function writeWorkerChange(session, files) {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(session.config.cwd, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function report(files, summary, action = 'created') {
  return {
    status: 'completed',
    summary,
    files: Object.keys(files).map((path) => ({ path, action })),
    tests: [{ command: `${NODE} -e process.exit(0)`, status: 'passed', summary: 'ok' }],
    unresolved: [],
  };
}

async function completeWorker(session, workReport) {
  session.emit({ kind: 'worker-signal', signal: { kind: 'progress', message: 'working' } });
  session.emit({ kind: 'worker-signal', signal: { kind: 'delivery', report: workReport } });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  session.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'completed' } });
}

async function latestReview(meetingId, taskId, attempt) {
  return waitFor(async () => {
    const journal = await MeetingRepository.replay(meetingId);
    return journal
      .filter((event) => event.type === 'coordinator-review-requested')
      .map((event) => event.payload?.data?.session)
      .filter((session) => (
        (session?.taskId === taskId || session?.taskId?.startsWith(`${taskId}-task-`))
        && session?.attempt === attempt
      ))
      .at(-1) ?? null;
  }, `Coordinator review did not start for ${taskId} attempt ${attempt}`);
}

/** Injects Coordinator verdicts directly. See the file header: this is not model review. */
async function reviewEveryChunk(orchestrator, reviewId, { pauseAfterFirst = false } = {}) {
  let reviewed = 0;
  for (;;) {
    const chunk = orchestrator.getDeliveryReviewChunk(reviewId);
    if (!chunk) break;
    await orchestrator.submitDeliveryChunkReview(reviewId, {
      chunkId: chunk.id,
      chunkHash: chunk.hash,
      verdict: 'passed',
      findings: [],
    });
    reviewed += 1;
    if (pauseAfterFirst && reviewed === 1) {
      await orchestrator.coordinatorReviewDriver.pauseForDisconnect(reviewId);
      const paused = orchestrator.inspectDeliveryReview(reviewId);
      assert.equal(paused.status, 'paused');
      await orchestrator.coordinatorReviewDriver.resume(reviewId);
      assert.equal(orchestrator.inspectDeliveryReview(reviewId).cursor, 1);
    }
  }
  const completed = await orchestrator.completeDeliveryReview(reviewId);
  assert.equal(completed.coverage.complete, true);
  return completed;
}

async function acceptedTask(orchestrator, taskId) {
  return waitFor(async () => {
    const source = await orchestrator.getTaskInspectorSource(taskId);
    return source?.task.status === 'accepted' ? source.task : null;
  }, `${taskId} did not reach durable accepted integration`);
}

test('injected-review orchestration drives the complete multi-backend Meeting workflow', {
  timeout: 120_000,
}, async (t) => {
  const repo = createRepository();
  const meetingId = `vertical-${randomUUID()}`;
  const taskWorktreeRoot = join(tmpdir(), 'ahastation-vertical-worktrees', meetingId);
  const integrationWorktree = join(
    homedir(),
    '.ahastation',
    'integration-worktrees',
    meetingId,
  );
  const sessions = [];
  const rendererEvents = [];
  const taskIds = ['task-login', 'task-unit', 'task-docs', 'task-regression'];
  let orchestrator;

  t.after(async () => {
    if (orchestrator) await orchestrator.end().catch(() => undefined);
    resetBackendRegistry();
    if (existsSync(integrationWorktree)) {
      try { git(repo.root, ['worktree', 'remove', '--force', integrationWorktree]); } catch {}
    }
    try { git(repo.root, ['worktree', 'prune']); } catch {}
    rmSync(taskWorktreeRoot, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  });

  resetBackendRegistry();
  const registry = getBackendRegistry();
  const claude = new ClaudeCodeBackend();
  const codex = new CodexBackend();
  registry.register(wrapBackend(
    claude,
    'claude-code',
    resolve('node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
    sessions,
  ));
  registry.register(wrapBackend(
    codex,
    'codex',
    resolve('node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),
    sessions,
  ));

  orchestrator = new Orchestrator({
    meetingId,
    cwd: repo.root,
    emit(event) { rendererEvents.push(event); },
    defaultBackendId: 'claude-code',
    workspaceManager: new TaskWorkspaceManager(meetingId, repo.root, {
      worktreeRoot: taskWorktreeRoot,
    }),
  });
  await orchestrator.start('Fix login validation, add tests and docs, and keep every check green.');

  const draft = [
    task('task-login', 'claude-code', [], ['src'], 'Draft login validation'),
    task('task-unit', 'codex', [], ['tests/unit'], 'Draft unit tests'),
    task('task-docs', 'codex', ['task-login'], ['docs'], 'Draft documentation'),
    task(
      'task-regression',
      'claude-code',
      ['task-login', 'task-unit', 'task-docs'],
      ['tests/regression'],
      'Draft regression pass',
    ),
  ];
  assert.deepEqual(await orchestrator.proposePlan(draft), { ok: true });
  const revised = structuredClone(draft);
  revised[0].title = 'Implement login validation';
  revised[1].title = 'Implement unit tests';
  assert.deepEqual(await orchestrator.approvePendingPlan(true, revised), { ok: true });

  const rootWorkers = await waitFor(
    () => sessions.filter((session) => session.config.executionRole === 'worker').length === 2
      ? sessions.filter((session) => session.config.executionRole === 'worker')
      : null,
    'Claude and Codex root Workers did not start in parallel',
  );
  assert.deepEqual(
    rootWorkers.map((session) => session.backendId).sort(),
    ['claude-code', 'codex'],
  );
  const loginSession = rootWorkers.find(
    (session) => taskIdForSession(session, taskIds) === 'task-login',
  );
  const unitSession = rootWorkers.find(
    (session) => taskIdForSession(session, taskIds) === 'task-unit',
  );
  assert.ok(loginSession);
  assert.ok(unitSession);

  const initialJournal = await waitFor(async () => {
    const journal = await MeetingRepository.replay(meetingId);
    const complete = ['task-login', 'task-unit'].every((taskId) => {
      const context = journal.find(
        (event) => event.type === 'context-package-frozen' && event.payload?.taskId === taskId,
      );
      const profile = journal.find(
        (event) => event.type === 'backend-profile-compiled' && event.payload?.taskId === taskId,
      );
      const grant = journal.find(
        (event) => event.type === 'task-authority-compiled' && event.payload?.taskId === taskId,
      );
      const spawned = journal.find(
        (event) => event.type === 'event:worker-spawned' && event.payload?.event?.workerId === taskId,
      );
      return Boolean(context && profile && grant && spawned);
    });
    return complete ? journal : null;
  }, 'root Workers did not persist frozen execution evidence before spawn');
  for (const taskId of ['task-login', 'task-unit']) {
    const context = initialJournal.find(
      (event) => event.type === 'context-package-frozen' && event.payload?.taskId === taskId,
    );
    const profile = initialJournal.find(
      (event) => event.type === 'backend-profile-compiled' && event.payload?.taskId === taskId,
    );
    const grant = initialJournal.find(
      (event) => event.type === 'task-authority-compiled' && event.payload?.taskId === taskId,
    );
    const spawned = initialJournal.find(
      (event) => event.type === 'event:worker-spawned' && event.payload?.event?.workerId === taskId,
    );
    assert.ok(context && profile && grant && spawned, `${taskId} missing frozen execution evidence`);
    assert.ok(context.seq < spawned.seq, `${taskId} context was not durable before spawn`);
    assert.ok(profile.seq < spawned.seq, `${taskId} profile was not durable before spawn`);
    assert.ok(grant.seq < spawned.seq, `${taskId} authority was not durable before spawn`);
    assert.equal('prompt' in grant.payload.data.authorityGrant, false);
  }

  loginSession.emit({
    kind: 'message',
    message: {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ready to implement' }] },
    },
  });
  loginSession.emit({
    kind: 'worker-signal',
    signal: { kind: 'tool', toolName: 'Edit', phase: 'started', detail: 'src/login.ts' },
  });
  const followUp = await orchestrator.queueTaskFollowUp('task-unit', 'Also cover the empty input case.');
  assert.equal(followUp.status, 'queued');
  const steer = await orchestrator.steerWorker('task-login', 'Preserve the public API shape.');
  assert.deepEqual(steer, { ok: true, queued: false });
  assert.deepEqual(loginSession.interrupts, ['steer']);

  unitSession.emit({
    kind: 'permission-request',
    id: 'high-risk-push',
    toolName: 'Bash',
    input: { command: ['git', 'push', '--force', 'origin', 'main'] },
    toolUseID: 'high-risk-push',
  });
  const approvalCard = await waitFor(
    () => rendererEvents.find(
      (entry) => entry.event?.kind === 'permission-request'
        && entry.event.id === 'high-risk-push',
    ),
    'high-risk permission did not reach the user',
  );
  assert.equal(approvalCard.event.toolName, 'Bash');
  assert.deepEqual(unitSession.permissions, []);
  orchestrator.resolvePermission('high-risk-push', 'allow', 'User approved this fixture request.');
  assert.deepEqual(unitSession.permissions, [{
    id: 'high-risk-push',
    decision: 'allow',
    message: 'User approved this fixture request.',
  }]);

  assert.equal(
    await orchestrator.forwardTaskMessage('task-login', 'task-unit', 'not-a-worker-question')
      .then(() => false, () => true),
    true,
    'Workers must not directly message peers without Coordinator-owned evidence',
  );

  const loginFiles = {
    'src/login.ts': 'export const validLogin = (value) => Boolean(value && value.trim());\n',
    'src/login-types.ts': 'export const LOGIN_KIND = \"strict\";\n',
  };
  const unitFiles = {
    'tests/unit/login.txt': 'empty=false; populated=true\n',
  };
  writeWorkerChange(loginSession, loginFiles);
  writeWorkerChange(unitSession, unitFiles);
  await Promise.all([
    completeWorker(loginSession, report(loginFiles, 'login implementation attempt one')),
    completeWorker(unitSession, report(unitFiles, 'unit tests complete')),
  ]);

  const loginReview1 = await latestReview(meetingId, 'task-login', 1);
  await orchestrator.requestDeliveryRework(loginReview1.id, [{
    code: 'missing-normalization',
    message: 'Normalize whitespace before validation.',
    blocking: true,
    path: 'src/login.ts',
  }]);
  const loginRetry = await waitFor(
    () => sessions.filter(
      (session) => (
        session.config.executionRole === 'worker'
        && taskIdForSession(session, taskIds) === 'task-login'
      ),
    ).at(1) ?? null,
    'login rework attempt did not start',
  );
  const loginRetryFiles = {
    'src/login.ts': 'export const validLogin = (value) => Boolean(value?.trim?.());\n',
  };
  writeWorkerChange(loginRetry, loginRetryFiles);
  await completeWorker(
    loginRetry,
    report({ ...loginFiles, ...loginRetryFiles }, 'login rework complete'),
  );

  const [loginReview2, unitReview] = await Promise.all([
    latestReview(meetingId, 'task-login', 2),
    latestReview(meetingId, 'task-unit', 1),
  ]);
  await Promise.all([
    reviewEveryChunk(orchestrator, loginReview2.id, { pauseAfterFirst: true }),
    reviewEveryChunk(orchestrator, unitReview.id),
  ]);
  await Promise.all([
    acceptedTask(orchestrator, 'task-login'),
    acceptedTask(orchestrator, 'task-unit'),
  ]);
  assert.equal(git(repo.root, ['rev-parse', 'HEAD']), repo.revision);
  assert.equal(git(repo.root, ['status', '--porcelain']), '');

  const docsSession = await waitFor(
    () => sessions.find(
      (session) => (
        session.config.executionRole === 'worker'
        && taskIdForSession(session, taskIds) === 'task-docs'
      ),
    ),
    'documentation dependency was not released',
  );
  const docsFiles = { 'docs/login.md': '# Login validation\n\nWhitespace-only values are rejected.\n' };
  writeWorkerChange(docsSession, docsFiles);
  await completeWorker(docsSession, report(docsFiles, 'documentation complete'));
  const docsReview = await latestReview(meetingId, 'task-docs', 1);
  await reviewEveryChunk(orchestrator, docsReview.id);
  await acceptedTask(orchestrator, 'task-docs');

  const regressionSession = await waitFor(
    () => sessions.find(
      (session) => (
        session.config.executionRole === 'worker'
        && taskIdForSession(session, taskIds) === 'task-regression'
      ),
    ),
    'regression dependency was not released',
  );
  const regressionFiles = { 'tests/regression/login.txt': 'login regression passed\n' };
  writeWorkerChange(regressionSession, regressionFiles);
  await completeWorker(regressionSession, report(regressionFiles, 'regression complete'));
  const regressionReview = await latestReview(meetingId, 'task-regression', 1);
  await reviewEveryChunk(orchestrator, regressionReview.id);
  await acceptedTask(orchestrator, 'task-regression');

  const beforePublication = git(repo.root, ['rev-parse', 'HEAD']);
  assert.equal(beforePublication, repo.revision, 'per-task acceptance must not publish the user base');
  const delivery = await waitFor(
    () => orchestrator.prepareFinalMeetingDelivery(),
    'final Meeting delivery was not produced',
  );
  assert.ok(delivery);
  assert.notEqual(delivery.integrationHead, repo.revision);
  const published = await orchestrator.acceptMeetingDelivery(delivery.id, delivery.contentHash);
  assert.equal(published.publicationState, 'published');
  assert.equal(git(repo.root, ['rev-parse', 'HEAD']), delivery.integrationHead);
  assert.equal(readFileSync(join(repo.root, 'src/login.ts'), 'utf8'), loginRetryFiles['src/login.ts']);
  assert.equal(readFileSync(join(repo.root, 'docs/login.md'), 'utf8'), docsFiles['docs/login.md']);

  const duplicate = await orchestrator.acceptMeetingDelivery(delivery.id, delivery.contentHash);
  assert.equal(duplicate.contentHash, delivery.contentHash);
  assert.equal(duplicate.publicationState, 'published');
  const finalJournal = await MeetingRepository.replay(meetingId);
  assert.equal(
    finalJournal.filter((event) => event.type === 'meeting-publication-completed').length,
    1,
  );
  assert.equal(
    finalJournal.filter((event) => event.type === 'integration-staging').length >= 4,
    true,
  );
  assert.equal(
    finalJournal.some((event) => (
      event.type === 'coordinator-review-chunk-submitted'
      && event.payload?.data?.session?.status === 'rework-requested'
    )),
    true,
  );
  assert.equal(
    finalJournal.some((event) => (
      event.type === 'task-message-enqueued'
      && event.payload?.taskId === 'task-unit'
      && event.payload?.data?.kind === 'follow-up'
    )),
    true,
  );
  assert.equal(
    finalJournal.some((event) => (
      event.type === 'task-permission-decided'
      && event.payload?.data?.decision === 'ask-user'
    )),
    true,
  );
});
