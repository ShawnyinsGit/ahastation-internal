import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

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

async function loadModules() {
  const pcmUrl = await transpileDataUrl('../electron/asr/pcm16.ts');
  const xfyunUrl = await transpileDataUrl(
    '../electron/asr/xfyun-iat.ts',
    [["'./pcm16.js'", JSON.stringify(pcmUrl)]],
  );
  return {
    pcm: await import(pcmUrl),
    xfyun: await import(xfyunUrl),
  };
}

class FakeWebSocket {
  readyState = 0;
  sent = [];
  listeners = new Map();

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
    this.readyState = 1;
    this.emit('open');
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Float32 audio is clamped and converted to signed PCM16 LE', async () => {
  const { pcm } = await loadModules();
  const output = pcm.float32ToPcm16(new Float32Array([-2, -1, 0, 1, 2]));
  assert.deepEqual(
    [...Array(5)].map((_, index) => output.readInt16LE(index * 2)),
    [-32768, -32768, 0, 32767, 32767],
  );
});

test('Xunfei auth URL contains an RFC1123 date and HMAC authorization', async () => {
  const { xfyun } = await loadModules();
  const url = new URL(xfyun.buildXfyunAuthUrl(
    { apiKey: 'test-key', apiSecret: 'test-secret' },
    new Date('2026-07-24T12:00:00Z'),
  ));
  assert.equal(url.protocol, 'wss:');
  assert.equal(url.host, 'iat-api.xfyun.cn');
  assert.equal(url.pathname, '/v2/iat');
  assert.equal(url.searchParams.get('host'), 'iat-api.xfyun.cn');
  assert.equal(url.searchParams.get('date'), 'Fri, 24 Jul 2026 12:00:00 GMT');
  const authorization = Buffer.from(
    url.searchParams.get('authorization'),
    'base64',
  ).toString('utf8');
  assert.match(authorization, /api_key="test-key"/);
  assert.match(authorization, /algorithm="hmac-sha256"/);
  assert.match(authorization, /headers="host date request-line"/);
  assert.match(authorization, /signature="[^"]+"/);
});

test('dynamic correction replaces the requested result range', async () => {
  const { xfyun } = await loadModules();
  const assembler = new xfyun.XfyunResultAssembler();
  assembler.accept({ sn: 0, pgs: 'apd', ws: [{ cw: [{ w: '你' }] }] });
  assembler.accept({ sn: 1, pgs: 'apd', ws: [{ cw: [{ w: '好' }] }] });
  assert.equal(assembler.text(), '你好');
  assembler.accept({
    sn: 2,
    pgs: 'rpl',
    rg: [0, 1],
    ws: [{ cw: [{ w: '您好' }] }],
  });
  assert.equal(assembler.text(), '您好');
});

test('stream sends 1280-byte audio frames, a final frame, and returns final text', async () => {
  const { xfyun } = await loadModules();
  const socket = new FakeWebSocket();
  const session = new xfyun.XfyunIatSession(
    { appId: 'app-id', apiKey: 'api-key', apiSecret: 'api-secret' },
    'zh',
    () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  );

  await session.start();
  session.pushFloat32(new Float32Array(640).fill(0.25));
  await wait(55);

  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].data.status, 0);
  assert.equal(socket.sent[0].common.app_id, 'app-id');
  assert.equal(socket.sent[0].business.language, 'zh_cn');
  assert.equal(Buffer.from(socket.sent[0].data.audio, 'base64').length, 1280);

  const finishing = session.finish();
  await wait(55);
  assert.equal(socket.sent.at(-1).data.status, 2);
  socket.emit('message', {
    data: JSON.stringify({
      code: 0,
      data: {
        status: 2,
        result: {
          sn: 0,
          pgs: 'apd',
          ws: [{ cw: [{ w: '实时测试成功' }] }],
        },
      },
    }),
  });
  assert.deepEqual(await finishing, { ok: true, text: '实时测试成功' });
});
