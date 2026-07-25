import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import test from 'node:test';

import { Orchestrator } from '../dist-electron/orchestrator.js';

// sendHostMessage used to reject any text over 20_000 chars. The auto-forwarded
// expert response path builds `[expert response from X] <text.slice(0,20_000)>`
// and ignores the return value, so the prefix pushed the total over the cap and
// the message was silently dropped - the Coordinator never saw long expert
// replies. These tests pin the truncate-and-deliver contract.

function recordingSessionFactory(sent) {
  return (opts) => ({
    opts,
    async start() {},
    end() {},
    sendUserText(text) { sent.push(text); },
    sendUserContent() {},
    resolvePermission() {},
    async interrupt() {},
  });
}

test('sendHostMessage truncates over-length text instead of dropping it', async () => {
  const meetingId = `host-msg-${randomUUID()}`;
  const sent = [];
  const orch = new Orchestrator({
    emit() {},
    cwd: '/tmp',
    meetingId,
    sessionFactory: recordingSessionFactory(sent),
    hostAskTimeoutMs: 0,
  });
  try {
    await orch.start();
    const result = orch.sendHostMessage('default', 'default', 'x'.repeat(30_000));
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    const delivered = sent.find((text) => text.includes('[cross-host from default]'));
    assert.ok(delivered, 'over-length message was delivered, not dropped');
    assert.ok(delivered.length < 30_000, 'delivered text was truncated to fit the cap');
    assert.match(delivered, /\[truncated\]/);
  } finally {
    await orch.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});

test('sendHostMessage passes short text through unchanged', async () => {
  const meetingId = `host-msg-short-${randomUUID()}`;
  const sent = [];
  const orch = new Orchestrator({
    emit() {},
    cwd: '/tmp',
    meetingId,
    sessionFactory: recordingSessionFactory(sent),
    hostAskTimeoutMs: 0,
  });
  try {
    await orch.start();
    const result = orch.sendHostMessage('default', 'default', 'short message');
    assert.equal(result.ok, true);
    assert.equal(result.truncated, false);
    const delivered = sent.find((text) => text.includes('short message'));
    assert.ok(delivered);
    assert.doesNotMatch(delivered, /\[truncated\]/);
  } finally {
    await orch.end();
    await rm(`/tmp/meetings/${meetingId}`, { recursive: true, force: true });
  }
});
