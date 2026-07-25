import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Unit tests for the realtime-stream lifecycle guards in electron/ipc/asr.ts:
// idle watchdog, idempotent stream-start reuse, and cancel semantics.
// electron, store, asr-polish, and format-error are stubbed via data URLs;
// the real xfyun-iat module runs against a fake WebSocket.

const IDLE_TIMEOUT_MS = 300;

async function transpileDataUrl(relativePath, replacements = []) {
  let source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
  for (const [search, replacement] of replacements) {
    source = source.replace(search, replacement);
  }
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
}

function moduleDataUrl(code) {
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
}

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.open());
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.emit('open');
  }
}

async function loadAsrIpc() {
  const handlers = new Map();
  const listeners = new Map();
  const electronUrl = moduleDataUrl(`
    export const ipcMain = {
      handle: (channel, fn) => globalThis.__asrHandlers.set(channel, fn),
      on: (channel, fn) => globalThis.__asrListeners.set(channel, fn),
    };
  `);
  const storeUrl = moduleDataUrl(`
    export const getSettings = () => ({
      xfyunAsr: { appId: 'test-appid', apiKey: 'test-key', apiSecret: 'test-secret' },
    });
  `);
  const polishUrl = moduleDataUrl(`
    export const polishAsrText = async (text) => text;
  `);
  const formatErrorUrl = moduleDataUrl(`
    export const errorMessage = (error) => String(error?.message ?? error);
  `);
  const pcmUrl = await transpileDataUrl('../electron/asr/pcm16.ts');
  const xfyunUrl = await transpileDataUrl(
    '../electron/asr/xfyun-iat.ts',
    [["'./pcm16.js'", JSON.stringify(pcmUrl)]],
  );
  const wsTransportUrl = moduleDataUrl(`
    export const createWsWebSocketFactory = () => (url) => {
      const socket = new globalThis.WebSocket(url);
      return socket;
    };
  `);
  const asrUrl = await transpileDataUrl('../electron/ipc/asr.ts', [
    ["'electron'", JSON.stringify(electronUrl)],
    ["'../store.js'", JSON.stringify(storeUrl)],
    ["'../asr-polish.js'", JSON.stringify(polishUrl)],
    ["'../format-error.js'", JSON.stringify(formatErrorUrl)],
    ["'../asr/xfyun-iat.js'", JSON.stringify(xfyunUrl)],
    ["'../asr/ws-transport.js'", JSON.stringify(wsTransportUrl)],
  ]);

  globalThis.__asrHandlers = handlers;
  globalThis.__asrListeners = listeners;
  globalThis.WebSocket = FakeWebSocket;
  process.env.AHASTATION_ASR_STREAM_IDLE_TIMEOUT_MS = String(IDLE_TIMEOUT_MS);

  const asr = await import(asrUrl);
  asr.registerAsrIpc();
  return { handlers, listeners };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pcmFrame(samples = 512) {
  return new Float32Array(samples).fill(0.1).buffer;
}

test('idle watchdog cancels a stream that never finishes and closes the socket', async () => {
  const { handlers } = await loadAsrIpc();
  const started = await handlers.get('asr:stream-start')(null, { lang: 'zh', includePreRoll: false });
  assert.equal(started.ok, true);
  const socket = FakeWebSocket.instances.at(-1);

  // No frames, no finish - the watchdog must reap the stream.
  await wait(IDLE_TIMEOUT_MS * 3);

  const probe = await handlers.get('asr:stream-cancel')(null);
  assert.deepEqual(probe, { ok: true }, 'stream should already be gone');
  assert.equal(socket.readyState, 3, 'socket should be closed');
});

test('live frames keep the stream alive; idleness afterwards reaps it', async () => {
  const { handlers, listeners } = await loadAsrIpc();
  const started = await handlers.get('asr:stream-start')(null, { lang: 'auto', includePreRoll: false });
  assert.equal(started.ok, true);

  const frame = listeners.get('asr:stream-frame');
  // Feed frames more often than the idle timeout for ~2.5 timeout periods.
  for (let i = 0; i < 5; i += 1) {
    frame(null, pcmFrame(), true);
    await wait(IDLE_TIMEOUT_MS / 2);
  }
  const wrongId = await handlers.get('asr:stream-cancel')(null, 'not-the-session-id');
  assert.equal(wrongId.ok, false, 'stream must still be active while frames flow');

  await wait(IDLE_TIMEOUT_MS * 3);
  const probe = await handlers.get('asr:stream-cancel')(null);
  assert.deepEqual(probe, { ok: true }, 'stream should be reaped after frames stop');
});

test('stream-start is idempotent while accepting; cancel frees the slot', async () => {
  const { handlers } = await loadAsrIpc();
  const first = await handlers.get('asr:stream-start')(null, { lang: 'zh', includePreRoll: false });
  assert.equal(first.ok, true);
  assert.equal(first.reused, undefined);

  const concurrent = await handlers.get('asr:stream-start')(null, { lang: 'zh', includePreRoll: false });
  assert.equal(concurrent.ok, true, 'healthy stream must be reused, not rejected');
  assert.equal(concurrent.reused, true);
  assert.equal(concurrent.sessionId, first.sessionId);

  await handlers.get('asr:stream-cancel')(null);
  const second = await handlers.get('asr:stream-start')(null, { lang: 'zh', includePreRoll: false });
  assert.equal(second.ok, true, 'cancel must free the slot');
  assert.equal(second.reused, undefined);
  await handlers.get('asr:stream-cancel')(null);
});

test('stream-start without configured credentials returns an error', async () => {
  // Reload with a store stub that has no xfyunAsr so the credentials check
  // fails - the user-facing "credentials not configured" path.
  const handlers = new Map();
  const listeners = new Map();
  const electronUrl = moduleDataUrl(`
    export const ipcMain = {
      handle: (channel, fn) => globalThis.__asrHandlers.set(channel, fn),
      on: (channel, fn) => globalThis.__asrListeners.set(channel, fn),
    };
  `);
  const storeUrl = moduleDataUrl(`export const getSettings = () => ({});`);
  const polishUrl = moduleDataUrl(`export const polishAsrText = async (text) => text;`);
  const formatErrorUrl = moduleDataUrl(`export const errorMessage = (error) => String(error?.message ?? error);`);
  const pcmUrl = await transpileDataUrl('../electron/asr/pcm16.ts');
  const xfyunUrl = await transpileDataUrl('../electron/asr/xfyun-iat.ts', [["'./pcm16.js'", JSON.stringify(pcmUrl)]]);
  const wsTransportUrl = moduleDataUrl(`
    export const createWsWebSocketFactory = () => (url) => new globalThis.WebSocket(url);
  `);
  const asrUrl = await transpileDataUrl('../electron/ipc/asr.ts', [
    ["'electron'", JSON.stringify(electronUrl)],
    ["'../store.js'", JSON.stringify(storeUrl)],
    ["'../asr-polish.js'", JSON.stringify(polishUrl)],
    ["'../format-error.js'", JSON.stringify(formatErrorUrl)],
    ["'../asr/xfyun-iat.js'", JSON.stringify(xfyunUrl)],
    ["'../asr/ws-transport.js'", JSON.stringify(wsTransportUrl)],
  ]);
  globalThis.__asrHandlers = handlers;
  globalThis.__asrListeners = listeners;
  const asr = await import(asrUrl);
  asr.registerAsrIpc();

  const started = await handlers.get('asr:stream-start')(null, { lang: 'zh', includePreRoll: false });
  assert.equal(started.ok, false);
  assert.match(started.error, /讯飞/);
});
