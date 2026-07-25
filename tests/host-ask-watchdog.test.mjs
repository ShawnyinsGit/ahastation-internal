import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Orchestrator } from '../dist-electron/orchestrator.js';
import { getBackendRegistry, resetBackendRegistry } from '../dist-electron/backends/registry.js';

// ask_host is fire-and-forget: the Coordinator has no way to know whether the
// expert ever replied. These tests pin the watchdog that nudges the
// Coordinator after a timeout, and clears when the expert answers.

function fakeRuntimeBinary() {
  const dir = mkdtempSync(join(tmpdir(), 'ahastation-host-ask-runtime-'));
  const binary = join(dir, 'runtime.cjs');
  writeFileSync(binary, `'use strict';\nconsole.log('2.1.150');\n`);
  return { dir, binary };
}

/** Minimal backend: resolveBinary so addHost's gate passes. The sessionFactory
 *  opt overrides createSession, so no real subprocess is spawned. */
function makeBackend(binaryPath) {
  return {
    id: 'claude-code',
    capabilities: { coordinate: true, executeTasks: true, defaultModel: 'claude-haiku-4-5' },
    resolveBinary: () => binaryPath,
    buildEnv: (_auth, extra) => extra,
    async validateAuth() { return { ok: true }; },
    async checkAuthStatus() { return { loggedIn: true }; },
  };
}

function makeSessionFactory(sessions) {
  return (options) => {
    const session = {
      options,
      // options.emit is the HostGroup onHostEvent callback; keep a handle so a
      // test can inject a talker message (simulating an expert reply).
      emit: options.emit,
      inputs: [],
      async start() {},
      end() {},
      sendUserText(text) { this.inputs.push(text); },
      sendUserContent() {},
      resolvePermission() {},
      async interrupt() {},
      snapshot() {
        return { protocol: 'claude-cli', sessionId: `s-${sessions.length + 1}`, backendVersion: '2.1.150' };
      },
    };
    sessions.push(session);
    return session;
  };
}

async function waitFor(predicate, message, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function findStalledBriefing(events) {
  return events.find((e) => (
    e.event?.kind === 'coordinator-briefing'
    && e.event.briefing?.kind === 'stalled'
    && Array.isArray(e.event.briefing.blockers)
    && e.event.briefing.blockers.includes('host-ask-timeout')
  ));
}

test('an unanswered ask_host times out and nudges the Coordinator', async () => {
  const runtime = fakeRuntimeBinary();
  const sessions = [];
  const events = [];
  const cwd = mkdtempSync(join(tmpdir(), 'host-ask-timeout-'));
  const meetingId = `host-ask-${randomUUID()}`;
  resetBackendRegistry();
  getBackendRegistry().register(makeBackend(runtime.binary));
  const orch = new Orchestrator({
    emit(event) { events.push(event); },
    cwd,
    meetingId,
    sessionFactory: makeSessionFactory(sessions),
    hostAskTimeoutMs: 40,
  });
  try {
    await orch.start();
    const coordinator = sessions[0];
    assert.ok(coordinator, 'coordinator host session was not created');
    assert.equal(orch.addHost('claude-code', 'expert').ok, true);
    await waitFor(
      () => events.some((e) => e.event?.kind === 'session-ready' && e.hostId === 'expert'),
      'expert host did not become ready',
    );

    assert.equal((await orch.executeMeetingCommand('default', {
      kind: 'ask-host',
      hostId: 'expert',
      question: 'should we ship?',
    })).ok, true);

    await waitFor(
      () => findStalledBriefing(events),
      'Coordinator was not nudged about the unanswered ask_host',
    );
    assert.ok(
      coordinator.inputs.some((text) => text.includes('长时间未回复')),
      'the Coordinator talker received the stall nudge',
    );
  } finally {
    await orch.end();
    resetBackendRegistry();
    rmSync(runtime.dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an expert reply before the timeout clears the ask_host watchdog', async () => {
  const runtime = fakeRuntimeBinary();
  const sessions = [];
  const events = [];
  const cwd = mkdtempSync(join(tmpdir(), 'host-ask-reply-'));
  const meetingId = `host-ask-reply-${randomUUID()}`;
  resetBackendRegistry();
  getBackendRegistry().register(makeBackend(runtime.binary));
  const orch = new Orchestrator({
    emit(event) { events.push(event); },
    cwd,
    meetingId,
    sessionFactory: makeSessionFactory(sessions),
    hostAskTimeoutMs: 40,
  });
  try {
    await orch.start();
    assert.equal(orch.addHost('claude-code', 'expert').ok, true);
    await waitFor(
      () => events.some((e) => e.event?.kind === 'session-ready' && e.hostId === 'expert'),
      'expert host did not become ready',
    );
    const expert = sessions[1];
    assert.ok(expert, 'expert host session was not created');

    assert.equal((await orch.executeMeetingCommand('default', {
      kind: 'ask-host',
      hostId: 'expert',
      question: 'should we ship?',
    })).ok, true);

    // Expert replies before the 40ms timer fires.
    expert.emit({
      kind: 'message',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'yes, ship it' }] },
        parent_tool_use_id: null,
        session_id: 'expert-1',
      },
    });

    // Wait past the timeout window.
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(
      findStalledBriefing(events),
      undefined,
      'a replied ask must not raise a host-ask-timeout briefing',
    );
  } finally {
    await orch.end();
    resetBackendRegistry();
    rmSync(runtime.dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
