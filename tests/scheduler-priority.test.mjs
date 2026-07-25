import assert from 'node:assert/strict';
import test from 'node:test';

import { WorkerScheduler } from '../dist-electron/worker-scheduler.js';

function createScheduler(overrides = {}) {
  const events = [];
  const sessions = [];
  const messages = new Map();
  const taskMailbox = {
    async enqueue(input) {
      const message = {
        schemaVersion: 1,
        id: `message-${messages.size + 1}`,
        seq: messages.size + 1,
        status: 'queued',
        timestamp: Date.now(),
        ...input,
      };
      messages.set(message.id, message);
      return structuredClone(message);
    },
    async markDelivered(_taskId, messageId) {
      const message = { ...messages.get(messageId), status: 'delivered' };
      messages.set(messageId, message);
      return structuredClone(message);
    },
    async markFailed(_taskId, messageId) {
      const message = { ...messages.get(messageId), status: 'queued' };
      messages.set(messageId, message);
      return structuredClone(message);
    },
    async acknowledge(_taskId, messageId) {
      const message = { ...messages.get(messageId), status: 'acknowledged' };
      messages.set(messageId, message);
      return structuredClone(message);
    },
    get(_taskId, messageId) {
      const message = messages.get(messageId);
      return message ? structuredClone(message) : undefined;
    },
    list(taskId) {
      return Array.from(messages.values()).filter((message) => message.taskId === taskId);
    },
  };
  const scheduler = new WorkerScheduler({
    emit(event) { events.push(event); },
    cwd: process.cwd(),
    autoApproveScope: 'off',
    sessionFactory(opts) {
      const session = {
        opts,
        inputs: [],
        async start() {},
        sendUserText(text) { this.inputs.push(text); },
        sendUserContent() {},
        resolvePermission() {},
        async interrupt() {},
        end() {},
      };
      sessions.push(session);
      return session;
    },
    buildWorkerMcp() { return {}; },
    getTalker() { return null; },
    isClosed() { return false; },
    getSpeechFilterMode() { return 'strict'; },
    taskMailbox,
    ...overrides,
  });
  return { scheduler, events, sessions, taskMailbox };
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function spawnedWorkerIds(events) {
  return events
    .map((entry) => entry.event)
    .filter((event) => event.kind === 'worker-spawned')
    .map((event) => event.workerId);
}

test('ready dispatch prefers the task blocking the most pending downstream work', async () => {
  const { scheduler, events, sessions } = createScheduler({ maxConcurrentWorkers: 1 });
  assert.deepEqual(scheduler.installPlan([
    { id: 'leaf', title: 'Leaf', prompt: 'standalone work', deps: [] },
    { id: 'hub', title: 'Hub', prompt: 'unblock the chain', deps: [] },
    { id: 'dep1', title: 'Dep 1', prompt: 'after hub', deps: ['hub'] },
    { id: 'dep2', title: 'Dep 2', prompt: 'also after hub', deps: ['hub'] },
  ]), { ok: true });
  await settle();

  // hub transitively blocks dep1+dep2; leaf blocks nothing. Despite leaf
  // being installed first, the single slot must go to hub.
  assert.equal(sessions.length, 1);
  assert.deepEqual(spawnedWorkerIds(events), ['hub']);
});

test('equal weights keep insertion (FIFO) order', async () => {
  const { scheduler, events, sessions } = createScheduler({ maxConcurrentWorkers: 1 });
  assert.deepEqual(scheduler.installPlan([
    { id: 'first', title: 'First', prompt: 'independent a', deps: [] },
    { id: 'second', title: 'Second', prompt: 'independent b', deps: [] },
  ]), { ok: true });
  await settle();

  assert.equal(sessions.length, 1);
  assert.deepEqual(spawnedWorkerIds(events), ['first']);
});

test('injected concurrency ceiling caps spawns and shapes the capacity briefing', async () => {
  const { scheduler, events, sessions } = createScheduler({ maxConcurrentWorkers: 2 });
  assert.deepEqual(scheduler.installPlan([
    { id: 't1', title: 'T1', prompt: 'work 1', deps: [] },
    { id: 't2', title: 'T2', prompt: 'work 2', deps: [] },
    { id: 't3', title: 'T3', prompt: 'work 3', deps: [] },
    { id: 't4', title: 'T4', prompt: 'work 4', deps: [] },
  ]), { ok: true });
  await settle();

  assert.equal(sessions.length, 2);
  const briefing = events
    .map((entry) => entry.event)
    .filter((event) => event.kind === 'coordinator-briefing')
    .map((event) => event.briefing)
    .find((entry) => entry.kind === 'capacity');
  assert.ok(briefing, 'expected a capacity briefing when the pool is saturated');
  assert.deepEqual(briefing.capacity, { running: 2, limit: 2, waiting: 2 });
});

test('omitting the option keeps the default ceiling of 4', async () => {
  const { scheduler, sessions } = createScheduler();
  assert.deepEqual(scheduler.installPlan([
    { id: 'a1', title: 'A1', prompt: 'work 1', deps: [] },
    { id: 'a2', title: 'A2', prompt: 'work 2', deps: [] },
    { id: 'a3', title: 'A3', prompt: 'work 3', deps: [] },
    { id: 'a4', title: 'A4', prompt: 'work 4', deps: [] },
    { id: 'a5', title: 'A5', prompt: 'work 5', deps: [] },
  ]), { ok: true });
  await settle();

  assert.equal(sessions.length, 4);
});
