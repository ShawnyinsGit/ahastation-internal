import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeMeetingCommand } from '../dist-electron/meeting-command.js';

test('experts cannot install executable plans', () => {
  const result = authorizeMeetingCommand({
    kind: 'propose-plan',
    tasks: [{ id: 'a', title: 'A', prompt: 'Do A', deps: [] }],
  }, { hostId: 'expert', role: 'expert' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'forbidden');
});

test('coordinator can propose a bounded validated plan', () => {
  const result = authorizeMeetingCommand({
    kind: 'propose-plan',
    tasks: [{ id: 'a', title: 'A', prompt: 'Do A', deps: [], executorBackendId: 'codex' }],
  }, { hostId: 'default', role: 'coordinator' });
  assert.equal(result.ok, true);
  assert.equal(result.command.tasks[0].executorBackendId, 'codex');
  assert.equal(result.command.tasks[0].executionProfile.backendId, 'codex');
  assert.deepEqual(result.command.tasks[0].authorityRequest.commands, []);
});

test('meeting command normalization uses the current Meeting default without adding authority', () => {
  const result = authorizeMeetingCommand({
    kind: 'propose-plan',
    tasks: [{ id: 'a', title: 'A', prompt: 'Inspect A', deps: [] }],
  }, { hostId: 'default', role: 'coordinator' }, { defaultBackendId: 'opencode' });
  assert.equal(result.ok, true);
  assert.equal(result.command.tasks[0].executionProfile.backendId, 'opencode');
  assert.equal(result.command.tasks[0].workspaceMode, 'read-only');
  assert.deepEqual(result.command.tasks[0].authorityRequest.toolKinds, ['read']);
  assert.deepEqual(result.command.tasks[0].authorityRequest.commands, []);
  assert.deepEqual(result.command.tasks[0].authorityRequest.networkHosts, []);
});

test('rejects malformed actor and oversized command input', () => {
  const result = authorizeMeetingCommand({ kind: 'ask-host', hostId: '../bad', question: 'hello' }, {
    hostId: 'default', role: 'coordinator',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-command');
});

test('rejects empty speak commands', () => {
  const result = authorizeMeetingCommand({ kind: 'speak', text: '' }, {
    hostId: 'default', role: 'coordinator',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-command');
});

test('coordinator command protocol includes plan revision, decisions and memory', () => {
  const actor = { hostId: 'default', role: 'coordinator' };
  const revised = authorizeMeetingCommand({
    kind: 'revise-plan',
    expectedPlanVersion: 1,
    reason: 'verification failed',
    operations: [{
      kind: 'add-task',
      task: { id: 'fix', title: 'Fix', prompt: 'repair the failure' },
    }],
  }, actor);
  assert.equal(revised.ok, true);

  const decision = authorizeMeetingCommand({
    kind: 'request-decision',
    question: 'Choose a rollout mode',
    options: [
      { title: 'A', summary: 'A', pros: [], cons: [], recommendationScore: 9 },
      { title: 'B', summary: 'B', pros: [], cons: [], recommendationScore: 5 },
    ],
    deadlineMs: Date.now() + 60_000,
  }, actor);
  assert.equal(decision.ok, true);

  const memory = authorizeMeetingCommand({
    kind: 'save-memory',
    category: 'decision',
    content: 'Use WorkerEvent v2',
    tags: ['protocol'],
  }, actor);
  assert.equal(memory.ok, true);
});

test('experts cannot revise plans, request decisions or save memory', () => {
  const actor = { hostId: 'expert', role: 'expert' };
  for (const command of [
    {
      kind: 'revise-plan',
      expectedPlanVersion: 1,
      reason: 'change',
      operations: [{
        kind: 'add-task',
        task: { id: 'fix', title: 'Fix', prompt: 'repair' },
      }],
    },
    {
      kind: 'request-decision',
      question: 'Choose',
      options: [
        { title: 'A', summary: 'A', pros: [], cons: [], recommendationScore: 9 },
        { title: 'B', summary: 'B', pros: [], cons: [], recommendationScore: 5 },
      ],
      deadlineMs: Date.now() + 60_000,
    },
    {
      kind: 'save-memory',
      category: 'fact',
      content: 'x',
      tags: [],
    },
  ]) {
    const result = authorizeMeetingCommand(command, actor);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'forbidden');
  }
});
