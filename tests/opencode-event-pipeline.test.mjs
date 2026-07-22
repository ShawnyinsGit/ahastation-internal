import assert from 'node:assert/strict';
import test from 'node:test';

import {
  basicAuthHeader,
  buildServerEnv,
  generateServerPassword,
  parseServerBanner,
} from '../dist-electron/backends/opencode-server-process.js';
import {
  createSseParser,
  extractEventSessionId,
  mapPartToNormalizedMessage,
  mergeResyncParts,
  partKeyOf,
} from '../dist-electron/backends/opencode-events.js';

// ---------------------------------------------------------------------------
// Banner parsing (spike §2: warning line may precede the banner)
// ---------------------------------------------------------------------------

test('parseServerBanner parses a plain banner line', () => {
  assert.equal(
    parseServerBanner('opencode server listening on http://127.0.0.1:4096'),
    'http://127.0.0.1:4096',
  );
});

test('parseServerBanner finds the banner after a warning line', () => {
  const output =
    'Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n' +
    'opencode server listening on http://127.0.0.1:56017\n';
  assert.equal(parseServerBanner(output), 'http://127.0.0.1:56017');
});

test('parseServerBanner returns null when no banner is present', () => {
  assert.equal(parseServerBanner('some log\nanother log\n'), null);
  assert.equal(parseServerBanner(''), null);
});

// ---------------------------------------------------------------------------
// Env whitelist (never leaks ambient secrets into the server process)
// ---------------------------------------------------------------------------

test('buildServerEnv keeps whitelisted vars and drops ambient secrets', () => {
  const env = buildServerEnv({
    password: 'pw123',
    config: { permission: { '*': 'ask' } },
    baseEnv: {
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'sk-secret',
      OPENAI_API_KEY: 'sk-other',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      OPENCODE_SERVER_PASSWORD: 'preexisting-override-me',
    },
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'pw123');
  assert.equal(env.OPENCODE_CONFIG_CONTENT, JSON.stringify({ permission: { '*': 'ask' } }));
  assert.equal('ANTHROPIC_API_KEY' in env, false);
  assert.equal('OPENAI_API_KEY' in env, false);
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
});

test('buildServerEnv passes only explicitly handed-in provider credentials', () => {
  const env = buildServerEnv({
    password: 'pw',
    providerEnv: { ANTHROPIC_API_KEY: 'explicit-key' },
    baseEnv: { PATH: '/bin' },
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'explicit-key');
  assert.equal(env.OPENCODE_CONFIG_CONTENT, '{}');
});

// ---------------------------------------------------------------------------
// OpenCodeBackend.buildEnv: settings key → provider env var (per chosen model)
// ---------------------------------------------------------------------------

test('buildEnv maps the settings apiKey to the provider of the chosen model', async () => {
  const { OpenCodeBackend } = await import('../dist-electron/backends/opencode-adapter.js');
  const backend = new OpenCodeBackend();

  // Default model is anthropic/* — key lands in ANTHROPIC_API_KEY only.
  const anthropic = backend.buildEnv({ authMode: 'apikey', apiKey: 'sk-ant-explicit' });
  assert.equal(anthropic.ANTHROPIC_API_KEY, 'sk-ant-explicit');
  assert.equal('OPENAI_API_KEY' in anthropic, false);

  // An openai/* model routes the same key to OPENAI_API_KEY (+ base URL).
  const openai = backend.buildEnv({
    authMode: 'apikey', apiKey: 'sk-openai-explicit',
    model: 'openai/gpt-5.4', baseUrl: 'https://gateway.example/v1',
  });
  assert.equal(openai.OPENAI_API_KEY, 'sk-openai-explicit');
  assert.equal(openai.OPENAI_BASE_URL, 'https://gateway.example/v1');
  assert.equal('ANTHROPIC_API_KEY' in openai, false);
});

test('buildEnv injects nothing without an apikey-mode key; extra passes through', async () => {
  const { OpenCodeBackend } = await import('../dist-electron/backends/opencode-adapter.js');
  const backend = new OpenCodeBackend();

  const none = backend.buildEnv({ authMode: 'none' }, { HOME: '/home/u' });
  assert.equal(none.HOME, '/home/u');
  assert.equal('ANTHROPIC_API_KEY' in none, false);
  assert.equal('OPENAI_API_KEY' in none, false);

  // A stored key with authMode 'oauth' (CLI-login flow) is not injected.
  const oauth = backend.buildEnv({ authMode: 'oauth', apiKey: 'sk-stale' });
  assert.equal('ANTHROPIC_API_KEY' in oauth, false);
});

// ---------------------------------------------------------------------------
// Password generation + Basic auth header
// ---------------------------------------------------------------------------

test('generateServerPassword produces unique high-entropy base64url tokens', () => {
  const a = generateServerPassword();
  const b = generateServerPassword();
  assert.notEqual(a, b);
  assert.equal(a.length, 32); // 24 bytes → 32 base64url chars (192 bits)
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('basicAuthHeader encodes opencode:<password> per Basic auth', () => {
  assert.equal(
    basicAuthHeader('pw'),
    `Basic ${Buffer.from('opencode:pw', 'utf8').toString('base64')}`,
  );
  assert.equal(
    basicAuthHeader('pw', 'aha'),
    `Basic ${Buffer.from('aha:pw', 'utf8').toString('base64')}`,
  );
});

// ---------------------------------------------------------------------------
// SSE framing: chunk splits, multi-line data, CRLF, comments
// ---------------------------------------------------------------------------

function collectFrames() {
  const frames = [];
  const parser = createSseParser((data) => frames.push(data));
  return { frames, parser };
}

test('SSE parser dispatches a complete single-chunk frame', () => {
  const { frames, parser } = collectFrames();
  parser.push('data: {"a":1}\n\n');
  assert.deepEqual(frames, ['{"a":1}']);
});

test('SSE parser stitches a frame split across chunks', () => {
  const { frames, parser } = collectFrames();
  parser.push('data: {"a"');
  assert.deepEqual(frames, []);
  parser.push(':1}\n');
  assert.deepEqual(frames, []);
  parser.push('\n');
  assert.deepEqual(frames, ['{"a":1}']);
});

test('SSE parser concatenates multi-line data fields and ignores comments/fields', () => {
  const { frames, parser } = collectFrames();
  parser.push(': heartbeat\n');
  parser.push('event: message\nid: 9\nretry: 1000\n');
  parser.push('data: line1\n');
  parser.push('data: line2\n');
  parser.push('\n');
  assert.deepEqual(frames, ['line1\nline2']);
});

test('SSE parser tolerates CRLF framing and multiple frames per chunk', () => {
  const { frames, parser } = collectFrames();
  parser.push('data: one\r\n\r\ndata: two\r\n\r\n');
  assert.deepEqual(frames, ['one', 'two']);
});

// ---------------------------------------------------------------------------
// Session attribution: part.sessionID vs info.sessionID vs instance-level
// ---------------------------------------------------------------------------

test('extractEventSessionId reads session-scoped carrier paths', () => {
  assert.equal(
    extractEventSessionId('message.part.updated', { part: { sessionID: 's1', id: 'p1' } }),
    's1',
  );
  assert.equal(
    extractEventSessionId('message.updated', { info: { sessionID: 's2', id: 'm1' } }),
    's2',
  );
  assert.equal(extractEventSessionId('session.created', { info: { id: 'sess_1' } }), 'sess_1');
  assert.equal(extractEventSessionId('session.idle', { sessionID: 's3' }), 's3');
  assert.equal(extractEventSessionId('permission.updated', { sessionID: 's4', id: 'perm' }), 's4');
  assert.equal(extractEventSessionId('todo.updated', { sessionID: 's5', todos: [] }), 's5');
  assert.equal(extractEventSessionId('session.error', { sessionID: 's6' }), 's6');
});

test('extractEventSessionId returns null for instance-level and malformed events', () => {
  assert.equal(extractEventSessionId('file.edited', { file: 'x.ts' }), null);
  assert.equal(extractEventSessionId('file.watcher.updated', { file: 'x', event: 'add' }), null);
  assert.equal(extractEventSessionId('vcs.branch.updated', { branch: 'main' }), null);
  assert.equal(extractEventSessionId('pty.created', { info: { id: 'pty_1' } }), null);
  assert.equal(extractEventSessionId('server.connected', {}), null);
  assert.equal(extractEventSessionId('session.error', {}), null); // sessionID optional
  assert.equal(extractEventSessionId('message.part.updated', { part: {} }), null);
  assert.equal(extractEventSessionId('whatever', null), null);
});

// ---------------------------------------------------------------------------
// Part → NormalizedMessage mapping
// ---------------------------------------------------------------------------

test('mapPartToNormalizedMessage maps text parts to assistant text blocks', () => {
  const msg = mapPartToNormalizedMessage({ type: 'text', text: 'hello', id: 'p1', messageID: 'm1' });
  assert.equal(msg.type, 'assistant');
  assert.deepEqual(msg.message.content, [{ type: 'text', text: 'hello' }]);
});

test('mapPartToNormalizedMessage maps tool parts to tool_use blocks with state.input', () => {
  const msg = mapPartToNormalizedMessage({
    type: 'tool',
    id: 'p2',
    messageID: 'm1',
    callID: 'call_1',
    tool: 'bash',
    state: { status: 'running', input: { command: 'ls -la' } },
  });
  assert.deepEqual(msg.message.content, [
    { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls -la' } },
  ]);
});

test('mapPartToNormalizedMessage skips empty text and unsupported part types', () => {
  assert.equal(mapPartToNormalizedMessage({ type: 'text', text: '' }), null);
  assert.equal(mapPartToNormalizedMessage({ type: 'reasoning', text: 'thinking' }), null);
  assert.equal(mapPartToNormalizedMessage(null), null);
});

// ---------------------------------------------------------------------------
// Checkpoint-resync merge: (messageID, partID) last-write-wins
// ---------------------------------------------------------------------------

const part = (messageID, id, text) => ({ messageID, id, type: 'text', text });

test('mergeResyncParts overlays buffered events on the snapshot, LWW', () => {
  const snapshot = [part('m1', 'p1', 'A1'), part('m1', 'p2', 'B1')];
  const buffered = [part('m1', 'p2', 'B2-newer'), part('m2', 'p9', 'C1')];
  const merged = mergeResyncParts(snapshot, buffered);
  assert.deepEqual(merged, [part('m1', 'p1', 'A1'), part('m1', 'p2', 'B2-newer'), part('m2', 'p9', 'C1')]);
});

test('mergeResyncParts is stable under out-of-order buffers', () => {
  const snapshot = [part('m1', 'p1', 'A1'), part('m1', 'p2', 'B1')];
  // Buffered arrivals out of order: new message first, then an update to an
  // existing part, then a stale duplicate of the same update.
  const buffered = [part('m2', 'p9', 'C1'), part('m1', 'p2', 'B2'), part('m1', 'p2', 'B3')];
  const merged = mergeResyncParts(snapshot, buffered);
  assert.deepEqual(merged, [part('m1', 'p1', 'A1'), part('m1', 'p2', 'B3'), part('m2', 'p9', 'C1')]);
});

test('mergeResyncParts keeps keyless parts last and handles empty inputs', () => {
  const keylessSnap = [{ type: 'snapshot', snapshot: 's' }];
  const keylessBuf = [{ type: 'snapshot', snapshot: 'b' }];
  assert.deepEqual(mergeResyncParts(keylessSnap, keylessBuf), [...keylessSnap, ...keylessBuf]);
  assert.deepEqual(mergeResyncParts([], []), []);
  assert.deepEqual(mergeResyncParts([part('m', 'p', 'x')], []), [part('m', 'p', 'x')]);
});

test('partKeyOf builds (messageID, partID) keys and rejects malformed parts', () => {
  assert.equal(partKeyOf({ messageID: 'm1', id: 'p1' }), 'm1:p1');
  assert.equal(partKeyOf({ id: 'p1' }), null);
  assert.equal(partKeyOf({}), null);
});
