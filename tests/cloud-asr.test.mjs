import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTranscriptionForm,
  cloudAsrEndpoint,
  errorMessageFromBody,
  resolveCloudAsrConfig,
  transcribeCloud,
} from '../dist-electron/cloud-asr.js';

const WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

// ---------------------------------------------------------------------------
// resolveCloudAsrConfig / cloudAsrEndpoint — config normalization
// ---------------------------------------------------------------------------

test('resolveCloudAsrConfig applies defaults and strips trailing slashes', () => {
  const r = resolveCloudAsrConfig({ apiKey: ' sk-x ', baseUrl: 'https://api.groq.com/openai/v1/', model: '' });
  assert.equal(r.apiKey, 'sk-x');
  assert.equal(r.baseUrl, 'https://api.groq.com/openai/v1');
  assert.equal(r.model, 'whisper-1');
});

test('resolveCloudAsrConfig falls back to the OpenAI base URL when unset', () => {
  const r = resolveCloudAsrConfig({ apiKey: 'k' });
  assert.equal(r.baseUrl, 'https://api.openai.com/v1');
  assert.equal(r.model, 'whisper-1');
});

test('resolveCloudAsrConfig throws when the apiKey is missing', () => {
  assert.throws(() => resolveCloudAsrConfig({}), /apiKey/);
  assert.throws(() => resolveCloudAsrConfig({ apiKey: '   ' }), /apiKey/);
});

test('cloudAsrEndpoint appends the transcriptions path exactly once', () => {
  assert.equal(
    cloudAsrEndpoint('https://api.openai.com/v1//'),
    'https://api.openai.com/v1/audio/transcriptions',
  );
});

// ---------------------------------------------------------------------------
// buildTranscriptionForm — multipart body shape
// ---------------------------------------------------------------------------

test('buildTranscriptionForm carries the WAV file and model field', () => {
  const form = buildTranscriptionForm(WAV, 'whisper-large-v3');
  assert.equal(form.get('model'), 'whisper-large-v3');
  const file = form.get('file');
  assert.ok(file && typeof file === 'object', 'file field must be a Blob/File');
  assert.equal(file.name, 'audio.wav');
  assert.equal(file.size, WAV.length);
  assert.equal(file.type, 'audio/wav');
});

// ---------------------------------------------------------------------------
// transcribeCloud — request construction, response parsing, error mapping
// ---------------------------------------------------------------------------

function stubFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { fn, calls };
}

test('transcribeCloud POSTs multipart to {baseUrl}/audio/transcriptions with a Bearer key', async () => {
  const { fn, calls } = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ text: '  你好世界  ' }),
    text: async () => '',
  }));
  const text = await transcribeCloud(WAV, { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_1', model: 'whisper-large-v3' }, { fetchImpl: fn });
  assert.equal(text, '你好世界');
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer gsk_1');
  assert.equal(init.body.get('model'), 'whisper-large-v3');
  assert.ok(init.body.get('file'));
});

test('transcribeCloud maps non-2xx to an error carrying the HTTP status and body message', async () => {
  const { fn } = stubFetch(() => ({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => JSON.stringify({ error: { message: 'Invalid API key' } }),
  }));
  await assert.rejects(
    transcribeCloud(WAV, { apiKey: 'bad' }, { fetchImpl: fn }),
    /HTTP 401.*Invalid API key/,
  );
});

test('transcribeCloud includes a truncated raw body for non-JSON error pages', async () => {
  const { fn } = stubFetch(() => ({
    ok: false,
    status: 502,
    json: async () => ({}),
    text: async () => '<html>bad gateway</html>',
  }));
  await assert.rejects(
    transcribeCloud(WAV, { apiKey: 'k' }, { fetchImpl: fn }),
    /HTTP 502.*bad gateway/,
  );
});

test('transcribeCloud rejects a 2xx response that is not valid JSON', async () => {
  const { fn } = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => { throw new SyntaxError('unexpected token'); },
    text: async () => '',
  }));
  await assert.rejects(
    transcribeCloud(WAV, { apiKey: 'k' }, { fetchImpl: fn }),
    /not valid JSON/,
  );
});

test('transcribeCloud rejects a 2xx response without a text field', async () => {
  const { fn } = stubFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ segments: [] }),
    text: async () => '',
  }));
  await assert.rejects(
    transcribeCloud(WAV, { apiKey: 'k' }, { fetchImpl: fn }),
    /missing the "text" field/,
  );
});

test('transcribeCloud times out when the fetch never settles', async () => {
  const { fn } = stubFetch((_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  }));
  await assert.rejects(
    transcribeCloud(WAV, { apiKey: 'k' }, { fetchImpl: fn, timeoutMs: 20 }),
    /timed out/,
  );
});

test('transcribeCloud wraps network failures with context', async () => {
  const { fn } = stubFetch(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(
    transcribeCloud(WAV, { apiKey: 'k' }, { fetchImpl: fn }),
    /cloud ASR request failed: fetch failed/,
  );
});

test('transcribeCloud requires an apiKey before hitting the network', async () => {
  let called = false;
  const fn = async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
  await assert.rejects(transcribeCloud(WAV, {}, { fetchImpl: fn }), /apiKey/);
  assert.equal(called, false);
});

// ---------------------------------------------------------------------------
// errorMessageFromBody — OpenAI-style error extraction
// ---------------------------------------------------------------------------

test('errorMessageFromBody prefers error.message and falls back to raw text', () => {
  assert.equal(errorMessageFromBody('{"error":{"message":"nope"}}'), 'nope');
  assert.equal(errorMessageFromBody('plain failure'), 'plain failure');
  assert.equal(errorMessageFromBody(''), '');
});
