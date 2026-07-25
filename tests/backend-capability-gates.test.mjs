import assert from 'node:assert/strict';
import test from 'node:test';

import { Orchestrator } from '../dist-electron/orchestrator.js';
import { getBackendRegistry } from '../dist-electron/backends/registry.js';
import {
  WORKER_STABILITY_GATES,
  assessWorkerRelease,
} from '../dist-electron/backends/worker-runtime-contract.js';

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function fakeSessionFactory() {
  return {
    start() {}, end() {}, sendUserText() {}, sendUserContent() {},
    resolvePermission() {}, async interrupt() {},
  };
}

test('the four release backends expose the tested Worker implementation contract', () => {
  const registry = getBackendRegistry();
  for (const backendId of ['claude-code', 'opencode', 'codex', 'kimi']) {
    const backend = registry.get(backendId);
    assert.equal(backend?.capabilities.executeTasks, true, `${backendId} Worker implementation`);
    assert.equal(backend?.capabilities.interrupt, true, `${backendId} interrupt contract`);
  }
  assert.equal(registry.get('qoder')?.capabilities.executeTasks, false);
});

function completeStabilityEvidence(backendId, runtimeVersion, overrides = {}) {
  return {
    runtimeCompatible: true,
    authReady: true,
    profileCompilation: true,
    workReport: true,
    interrupt: true,
    resume: true,
    permissionBridge: true,
    canonicalPermissionNormalization: true,
    recovery: true,
    realVerticalSmoke: {
      schemaVersion: 1,
      kind: 'real-backend-smoke',
      backendId,
      runtimeVersion,
      runId: `real-${backendId}-2026-07-24`,
      verifiedAt: '2026-07-24T08:00:00.000Z',
      checks: [
        'work-report',
        'interrupt',
        'resume',
        'permission-bridge',
        'canonical-permission-normalization',
        'recovery',
      ],
    },
    ...overrides,
  };
}

test('stable Worker qualification requires every gate and exact real smoke evidence', () => {
  const missingReal = completeStabilityEvidence('claude-code', '2.1.150');
  delete missingReal.realVerticalSmoke;
  const incomplete = assessWorkerRelease({
    backendId: 'claude-code',
    implementationEnabled: true,
    expectedRuntimeVersion: '2.1.150',
    evidence: missingReal,
  });
  assert.equal(incomplete.tier, 'experimental');
  assert.deepEqual(incomplete.blockers, ['real-vertical-smoke']);

  const mismatched = assessWorkerRelease({
    backendId: 'codex',
    implementationEnabled: true,
    expectedRuntimeVersion: '0.144.1',
    evidence: completeStabilityEvidence('codex', '0.144.6'),
  });
  assert.equal(mismatched.tier, 'experimental');
  assert.equal(mismatched.gates['real-vertical-smoke'], false);

  const stable = assessWorkerRelease({
    backendId: 'codex',
    implementationEnabled: true,
    expectedRuntimeVersion: '0.144.1',
    evidence: completeStabilityEvidence('codex', '0.144.1'),
  });
  assert.equal(stable.tier, 'stable');
  assert.deepEqual(stable.blockers, []);
  assert.deepEqual(Object.keys(stable.gates).sort(), [...WORKER_STABILITY_GATES].sort());
});

test('OpenCode and Kimi remain experimental even with complete mocked-looking gates', () => {
  const registry = getBackendRegistry();
  for (const [backendId, version] of [['opencode', '1.18.3'], ['kimi', '0.24.1']]) {
    const assessment = registry.assessWorkerRelease(
      backendId,
      version,
      completeStabilityEvidence(backendId, version),
    );
    assert.equal(assessment.tier, 'experimental');
    assert.deepEqual(assessment.blockers, []);
    assert.match(assessment.reason, /policy keeps this Worker experimental/i);
  }
});

test('a backend without coordinator capability cannot become the default coordinator', () => {
  assert.throws(() => new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
    defaultBackendId: 'kimi',
  }), /cannot coordinate/i);
});

test('a plan cannot select a backend that cannot execute delivery tasks', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
    defaultBackendId: 'claude-code',
  });
  try {
    const result = await orchestrator.installPlan([{
      id: 'unsupported-worker',
      title: 'Unsupported worker',
      prompt: 'Do the task',
      executorBackendId: 'qoder',
    }]);
    assert.deepEqual(result, {
      ok: false,
      error: "backend 'qoder' cannot execute delivery tasks",
    });
  } finally {
    await orchestrator.end();
  }
});

test('unknown executor backends fail instead of silently falling back to Claude', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
  });
  try {
    const result = await orchestrator.installPlan([{
      id: 'unknown-worker',
      title: 'Unknown worker',
      prompt: 'Do the task',
      executorBackendId: 'missing-backend',
    }]);
    assert.deepEqual(result, {
      ok: false,
      error: "backend 'missing-backend' is not registered",
    });
  } finally {
    await orchestrator.end();
  }
});

test('Codex coordinator can delegate through its verified Worker contract', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: fakeSessionFactory,
    defaultBackendId: 'codex',
  });
  try {
    const delegated = await orchestrator.delegateSingleTask('change the code');
    assert.equal(delegated.ok, true);
    assert.match(delegated.workerId, /^task-/);
    assert.equal(delegated.reused, false);
    assert.equal(delegated.status, 'spawned');
  } finally {
    await orchestrator.end();
  }
});

test('a connecting host cannot take over coordination before readiness', async () => {
  let sessionCount = 0;
  let releaseSecond;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: () => {
      sessionCount += 1;
      return {
        async start() { if (sessionCount === 2) await secondReady; },
        end() {}, sendUserText() {}, sendUserContent() {}, resolvePermission() {},
        async interrupt() {},
      };
    },
  });
  try {
    await orchestrator.start();
    const added = orchestrator.addHost('codex', 'connecting-codex');
    assert.equal(added.ok, true);
    assert.deepEqual(orchestrator.setCoordinator('connecting-codex'), {
      ok: false,
      error: "host group 'connecting-codex' is not ready",
    });
    releaseSecond();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(orchestrator.setCoordinator('connecting-codex').ok, true);
  } finally {
    await orchestrator.end();
  }
});

test('a meeting admits at most three hosts including the default coordinator', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: () => ({
      async start() {}, end() {}, sendUserText() {}, sendUserContent() {},
      resolvePermission() {}, async interrupt() {},
    }),
  });
  try {
    await orchestrator.start();
    assert.equal(orchestrator.addHost('codex', 'host-two').ok, true);
    assert.equal(orchestrator.addHost('codex', 'host-three').ok, true);
    assert.deepEqual(orchestrator.addHost('codex', 'host-four'), {
      ok: false,
      error: 'host capacity reached (3/3)',
    });
  } finally {
    await orchestrator.end();
  }
});

test('host listings include the native backend session reference for recovery', async () => {
  const orchestrator = new Orchestrator({
    emit() {},
    cwd: process.cwd(),
    sessionFactory: () => ({
      async start() {}, end() {}, sendUserText() {}, sendUserContent() {},
      resolvePermission() {}, async interrupt() {},
      snapshot() { return { protocol: 'codex-sdk', sessionId: 'thread-persisted' }; },
    }),
  });
  try {
    await orchestrator.start();
    assert.deepEqual(orchestrator.listHosts()[0].backendSession, {
      protocol: 'codex-sdk',
      sessionId: 'thread-persisted',
    });
  } finally {
    await orchestrator.end();
  }
});

test('a backend mention routes the user turn to the ready expert instead of the coordinator', async () => {
  const sessions = [];
  const prompts = [];
  const emitted = [];
  const orchestrator = new Orchestrator({
    emit(event) { emitted.push(event); },
    cwd: process.cwd(),
    sessionFactory: (opts) => {
      const inputs = [];
      sessions.push({ inputs, emit: opts.emit });
      prompts.push(String(opts.sessionOptions?.systemPrompt ?? ''));
      return {
        async start() {}, end() {},
        sendUserText(text) { inputs.push(text); },
        sendUserContent() {}, resolvePermission() {}, async interrupt() {},
      };
    },
  });
  try {
    await orchestrator.start();
    assert.equal(orchestrator.addHost('codex', 'codex-expert').ok, true);
    await new Promise((resolve) => setImmediate(resolve));

    orchestrator.sendUserText('排查 ASR 为什么启动失败@codex');

    assert.deepEqual(sessions[0].inputs, [], 'the coordinator must not consume a directly addressed expert turn');
    assert.equal(sessions[1].inputs.length, 1, 'the expert receives exactly the user-directed turn, not a startup greeting');
    assert.match(sessions[1].inputs[0], /排查 ASR 为什么启动失败/);
    assert.doesNotMatch(sessions[1].inputs[0], /@codex/);
    assert.match(prompts[0], /Coordinator/i);
    assert.match(prompts[1], /Expert/i);

    sessions[1].emit({
      kind: 'message',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ASR 依赖没有加载成功。' }] },
      },
    });
    await waitFor(
      () => emitted.some((event) => event.hostId === 'codex-expert' && event.event.kind === 'message'),
      'the expert response should emit after its journal entry is durable',
    );
    assert.ok(emitted.some((event) => event.hostId === 'codex-expert' && event.event.kind === 'message'));
    assert.match(sessions[0].inputs[0], /expert response from codex-expert.*ASR 依赖没有加载成功/s);
  } finally {
    await orchestrator.end();
  }
});

test('narrating one assistant line does not feed a new turn back into the host', async () => {
  const emittedLines = [];
  const hostInputs = [];
  let orchestrator;
  orchestrator = new Orchestrator({
    emit(event) {
      const content = event.event?.message?.message?.content;
      const text = Array.isArray(content) ? content.find((block) => block.type === 'text')?.text : '';
      if (event.event?.kind === 'message' && text) emittedLines.push(text);
    },
    cwd: process.cwd(),
    sessionFactory: () => ({
      async start() {}, end() {},
      sendUserText(text) {
        hostInputs.push(text);
        // Recreate the production failure deterministically: Codex responds to
        // the synthetic "you just spoke" turn with another speak command.
        if (text.startsWith('(you just spoke to the user)') && hostInputs.length < 4) {
          orchestrator.narrateAssistantLine(`loop-${hostInputs.length}`);
        }
      },
      sendUserContent() {}, resolvePermission() {}, async interrupt() {},
    }),
  });
  try {
    await orchestrator.start();
    orchestrator.narrateAssistantLine('one intended line');
    await waitFor(
      () => emittedLines.length === 1,
      'the narration should emit after its journal entry is durable',
    );
    assert.deepEqual(emittedLines, ['one intended line']);
    assert.deepEqual(hostInputs, []);
  } finally {
    await orchestrator.end();
  }
});
