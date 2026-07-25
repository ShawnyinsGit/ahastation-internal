import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { z } from 'zod';

import { query, buildCliArgs, buildInitializeBody } from '../dist-electron/claude-cli/driver.js';
import { createSdkMcpServer, tool } from '../dist-electron/claude-cli/inproc-mcp.js';
import { spawnTargetFor } from '../dist-electron/claude-cli/resolve.js';

// ── Fake child process ──────────────────────────────────────────────────────

class FakeProc extends EventEmitter {
  constructor() {
    super();
    this.stdinChunks = [];
    this.stdin = {
      writableEnded: false,
      write: (d) => { this.stdinChunks.push(d); return true; },
      end: () => { this.stdin.writableEnded = true; },
    };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitCode = null;
  }

  kill() { this.killed = true; return true; }

  /** All frames the driver wrote to stdin, parsed. */
  stdinFrames() {
    return this.stdinChunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  lastControlRequest(subtype) {
    const frames = this.stdinFrames().filter(
      (f) => f.type === 'control_request' && f.request?.subtype === subtype,
    );
    return frames.at(-1);
  }

  controlResponses() {
    return this.stdinFrames().filter((f) => f.type === 'control_response');
  }

  send(frame) { this.stdout.emit('data', `${JSON.stringify(frame)}\n`); }
  sendRaw(text) { this.stdout.emit('data', text); }

  replyControl(requestId, response) {
    this.send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  exit(code) { this.exitCode = code; this.emit('exit', code, null); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function singlePrompt(text = 'hi') {
  return (async function* () {
    yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    // Mirror ClaudeSession's long-lived input queue: the prompt never ends,
    // so stdin stays open for control frames (interrupt, control_response)
    // until close(). A single-shot generator would end stdin on completion.
    await new Promise(() => {});
  })();
}

function makeQuery(options = {}) {
  const proc = new FakeProc();
  let spec;
  const q = query({
    prompt: options.prompt ?? singlePrompt(),
    options: {
      cwd: '/tmp/work',
      resolveBinary: () => '/fake/claude',
      spawnProcess: (s) => { spec = s; return proc; },
      ...options.driverOptions,
    },
  });
  return { q, proc, spec: () => spec };
}

/** Spawn + answer the initialize handshake. */
async function handshake(proc, initResponse = { account: { apiProvider: 'firstParty', tokenSource: 'oauth' } }) {
  await tick();
  const init = proc.lastControlRequest('initialize');
  assert.ok(init, 'driver must send an initialize control request');
  proc.replyControl(init.request_id, initResponse);
  return init;
}

// ── argv construction ───────────────────────────────────────────────────────

test('buildCliArgs maps base flags and session options onto the CLI argv', () => {
  const base = buildCliArgs({}, { hasCanUseTool: false, externalMcpServers: {} });
  assert.deepEqual(base, [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  ]);

  const full = buildCliArgs(
    {
      model: 'claude-sonnet-4-20250514',
      resume: 'sess-1',
      permissionMode: 'acceptEdits',
      effort: 'high',
      thinking: { type: 'enabled', budgetTokens: 4096 },
      tools: ['Read', 'Bash'],
      skills: ['commit', 'review'],
      settingSources: ['user', 'project'],
    },
    { hasCanUseTool: true, externalMcpServers: {} },
  );
  assert.deepEqual(full, [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--max-thinking-tokens', '4096',
    '--effort', 'high',
    '--model', 'claude-sonnet-4-20250514',
    '--resume', 'sess-1',
    '--allowedTools', 'Skill(commit),Skill(review)',
    '--tools', 'Read,Bash',
    '--setting-sources=user,project',
    '--permission-mode', 'acceptEdits',
    '--permission-prompt-tool', 'stdio',
  ]);
});

test('buildCliArgs edge cases: empty tools, default tools, skill variants, thinking modes', () => {
  const extra = { hasCanUseTool: false, externalMcpServers: {} };
  assert.deepEqual(
    buildCliArgs({ tools: [] }, extra).filter((a, i, arr) => arr[i - 1] === '--tools' || a === '--tools'),
    ['--tools', ''],
  );
  assert.ok(buildCliArgs({ tools: { type: 'default' } }, extra).includes('default'));

  // skills 'all' advertises the bare Skill tool; an empty list advertises none.
  assert.ok(buildCliArgs({ skills: 'all' }, extra).includes('Skill'));
  assert.equal(buildCliArgs({ skills: [] }, extra).includes('--allowedTools'), false);

  // Empty settingSources still emits the (empty) flag so the CLI skips user/project/local files.
  assert.ok(buildCliArgs({ settingSources: [] }, extra).includes('--setting-sources='));

  assert.deepEqual(
    buildCliArgs({ thinking: { type: 'disabled' } }, extra).slice(5),
    ['--thinking', 'disabled'],
  );
  assert.deepEqual(
    buildCliArgs({ thinking: { type: 'adaptive', display: 'summarized' } }, extra).slice(5),
    ['--thinking', 'adaptive', '--thinking-display', 'summarized'],
  );
});

test('buildCliArgs only forwards external (non-sdk) MCP servers via --mcp-config', () => {
  const args = buildCliArgs({}, {
    hasCanUseTool: false,
    externalMcpServers: { remote: { type: 'http', url: 'https://x' } },
  });
  const idx = args.indexOf('--mcp-config');
  assert.ok(idx > 0);
  assert.deepEqual(JSON.parse(args[idx + 1]), { mcpServers: { remote: { type: 'http', url: 'https://x' } } });

  assert.equal(
    buildCliArgs({}, { hasCanUseTool: false, externalMcpServers: {} }).includes('--mcp-config'),
    false,
  );
});

test('buildInitializeBody maps systemPrompt shapes and skills onto the handshake body', () => {
  assert.deepEqual(buildInitializeBody({}, []), {
    sdkMcpServers: undefined,
    systemPrompt: [''],
    appendSystemPrompt: undefined,
    excludeDynamicSections: undefined,
    skills: undefined,
  });

  assert.deepEqual(buildInitializeBody({ systemPrompt: 'be brief' }, ['meeting']), {
    sdkMcpServers: ['meeting'],
    systemPrompt: ['be brief'],
    appendSystemPrompt: undefined,
    excludeDynamicSections: undefined,
    skills: undefined,
  });

  assert.deepEqual(
    buildInitializeBody(
      {
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra', excludeDynamicSections: true },
        skills: ['commit'],
      },
      [],
    ),
    {
      sdkMcpServers: undefined,
      systemPrompt: undefined,
      appendSystemPrompt: 'extra',
      excludeDynamicSections: true,
      skills: ['commit'],
    },
  );

  // skills: 'all' is an argv-level concern; the initialize body omits it.
  assert.equal(buildInitializeBody({ skills: 'all' }, []).skills, undefined);
});

test('spawnTargetFor routes Windows .cmd shims through cmd.exe', () => {
  if (process.platform !== 'win32') return;
  assert.deepEqual(spawnTargetFor('C:\\x\\claude.cmd', ['--version']), {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', 'C:\\x\\claude.cmd', '--version'],
  });
  assert.deepEqual(spawnTargetFor('C:\\x\\claude.exe', ['--version']), {
    file: 'C:\\x\\claude.exe',
    args: ['--version'],
  });
});

// ── Lifecycle ───────────────────────────────────────────────────────────────

test('query throws synchronously when no claude binary can be resolved', () => {
  assert.throws(
    () => query({
      prompt: singlePrompt(),
      options: { cwd: '/tmp/work', resolveBinary: () => null, spawnProcess: () => new FakeProc() },
    }),
    /Claude CLI not found/,
  );
});

test('handshake carries sdkMcpServers, env fixes, and resolves initializationResult', async () => {
  const server = createSdkMcpServer({ name: 'meeting', tools: [] });
  const { q, proc, spec } = makeQuery({
    driverOptions: {
      mcpServers: { meeting: server },
      systemPrompt: 'sys',
      env: { PATH: '/usr/bin', NODE_OPTIONS: '--inspect', DEBUG: '1' },
    },
  });

  const init = await handshake(proc);
  assert.deepEqual(init.request.sdkMcpServers, ['meeting']);
  assert.deepEqual(init.request.systemPrompt, ['sys']);

  // argv base flags and cwd land on the spawn spec.
  assert.deepEqual(spec().args.slice(0, 5), [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  ]);
  assert.equal(spec().cwd, '/tmp/work');
  assert.equal(spec().env.CLAUDE_CODE_ENTRYPOINT, 'aha-cli');
  assert.equal('NODE_OPTIONS' in spec().env, false);
  assert.equal('DEBUG' in spec().env, false);

  const result = await q.initializationResult();
  assert.equal(result.account.tokenSource, 'oauth');

  q.close();
  assert.equal(proc.killed, true);
  // close() ends the stream cleanly.
  assert.deepEqual(await q.next(), { value: undefined, done: true });
});

test('stream messages arrive in order and the loop ends on clean exit', async () => {
  const { q, proc } = makeQuery();
  await handshake(proc);

  proc.send({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } });
  proc.send({ type: 'result', subtype: 'success' });
  proc.exit(0);

  const seen = [];
  for await (const msg of q) seen.push(msg.type);
  assert.deepEqual(seen, ['assistant', 'result']);
});

// ── Permission bridge (can_use_tool) ────────────────────────────────────────

test('can_use_tool round-trips through the canUseTool callback with toolUseID', async () => {
  const calls = [];
  const { q, proc } = makeQuery({
    driverOptions: {
      canUseTool: async (toolName, input, opts) => {
        calls.push({ toolName, input, opts });
        return { behavior: 'allow', updatedInput: { ...input, approved: true } };
      },
    },
  });
  await handshake(proc);

  proc.send({
    type: 'control_request',
    request_id: 'perm-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'ls' },
      tool_use_id: 'tu-9',
      decision_reason: 'write outside workspace',
    },
  });
  await tick();
  await tick();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, 'Bash');
  assert.deepEqual(calls[0].input, { command: 'ls' });
  assert.equal(calls[0].opts.toolUseID, 'tu-9');
  assert.equal(calls[0].opts.decisionReason, 'write outside workspace');
  assert.ok(calls[0].opts.signal instanceof AbortSignal);

  const responses = proc.controlResponses();
  assert.equal(responses.length, 1);
  assert.deepEqual(responses[0].response, {
    subtype: 'success',
    request_id: 'perm-1',
    response: { behavior: 'allow', updatedInput: { command: 'ls', approved: true }, toolUseID: 'tu-9' },
  });

  q.close();
});

test('can_use_tool without a callback answers an error control_response', async () => {
  const { q, proc } = makeQuery();
  await handshake(proc);

  proc.send({
    type: 'control_request',
    request_id: 'perm-2',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {}, tool_use_id: 'tu-1' },
  });
  await tick();
  await tick();

  const responses = proc.controlResponses();
  assert.equal(responses.length, 1);
  assert.equal(responses[0].response.subtype, 'error');
  assert.equal(responses[0].response.request_id, 'perm-2');
  assert.match(responses[0].response.error, /canUseTool/);

  q.close();
});

test('--permission-prompt-tool stdio is only passed when canUseTool is set', async () => {
  const withCb = makeQuery({ driverOptions: { canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }) } });
  assert.ok(withCb.spec().args.includes('--permission-prompt-tool'));
  withCb.q.close();

  const without = makeQuery();
  assert.equal(without.spec().args.includes('--permission-prompt-tool'), false);
  without.q.close();
});

// ── Outbound control requests ───────────────────────────────────────────────

test('interrupt and setPermissionMode emit control requests and settle on response', async () => {
  const { q, proc } = makeQuery();
  await handshake(proc);

  const interruptDone = q.interrupt();
  await tick();
  const interruptFrame = proc.lastControlRequest('interrupt');
  assert.ok(interruptFrame);
  proc.replyControl(interruptFrame.request_id, {});
  await interruptDone;

  const modeDone = q.setPermissionMode('acceptEdits');
  await tick();
  const modeFrame = proc.lastControlRequest('set_permission_mode');
  assert.equal(modeFrame.request.mode, 'acceptEdits');
  proc.replyControl(modeFrame.request_id, {});
  await modeDone;

  q.close();
});

// ── In-process MCP bridge (mcp_message) ─────────────────────────────────────

test('mcp_message bridges tools/list and tools/call into the in-process server', async () => {
  const server = createSdkMcpServer({
    name: 'meeting',
    tools: [
      tool('ping', 'ping the host', { msg: z.string() }, async (args) => ({
        content: [{ type: 'text', text: `pong:${args.msg}` }],
      })),
    ],
  });
  const { q, proc } = makeQuery({ driverOptions: { mcpServers: { meeting: server } } });
  await handshake(proc);

  proc.send({
    type: 'control_request',
    request_id: 'mcp-1',
    request: {
      subtype: 'mcp_message',
      server_name: 'meeting',
      message: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    },
  });
  await tick();
  await tick();

  const listResponse = proc.controlResponses().at(-1);
  assert.equal(listResponse.response.subtype, 'success');
  const tools = listResponse.response.response.mcp_response.result.tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ping');
  assert.equal(tools[0].inputSchema.type, 'object');

  proc.send({
    type: 'control_request',
    request_id: 'mcp-2',
    request: {
      subtype: 'mcp_message',
      server_name: 'meeting',
      message: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: { msg: 'hi' } } },
    },
  });
  await tick();
  await tick();

  const callResponse = proc.controlResponses().at(-1);
  assert.deepEqual(
    callResponse.response.response.mcp_response.result.content,
    [{ type: 'text', text: 'pong:hi' }],
  );

  // Unknown server name is an error, not a hang.
  proc.send({
    type: 'control_request',
    request_id: 'mcp-3',
    request: { subtype: 'mcp_message', server_name: 'nope', message: { jsonrpc: '2.0', id: 3, method: 'ping' } },
  });
  await tick();
  await tick();
  const missing = proc.controlResponses().at(-1);
  assert.equal(missing.response.subtype, 'error');
  assert.match(missing.response.error, /SDK MCP server not found: nope/);

  q.close();
});

// ── Robustness ──────────────────────────────────────────────────────────────

test('torn stdout lines are reassembled before dispatch', async () => {
  const { q, proc } = makeQuery();
  await handshake(proc);

  const frame = JSON.stringify({ type: 'assistant', message: { content: [] } });
  proc.sendRaw(frame.slice(0, 10));
  await tick();
  proc.sendRaw(`${frame.slice(10)}\n`);

  const first = await q.next();
  assert.equal(first.value.type, 'assistant');
  q.close();
});

test('non-JSON stdout lines are dropped, not fatal', async () => {
  const logs = [];
  const { q, proc } = makeQuery({ driverOptions: { log: (l) => logs.push(l) } });
  await handshake(proc);

  proc.sendRaw('some plain CLI banner text\n');
  proc.send({ type: 'result', subtype: 'success' });

  const msg = await q.next();
  assert.equal(msg.value.type, 'result');
  assert.equal(logs.length, 1);
  q.close();
});

test('a crashing process rejects initializationResult and the message stream', async () => {
  const { q, proc } = makeQuery();
  await tick();
  proc.exit(2);

  await assert.rejects(q.initializationResult(), /exited with code 2/);
  await assert.rejects(q.next(), /exited with code 2/);
});

test('breaking out of the message loop kills the CLI process', async () => {
  const { q, proc } = makeQuery();
  await handshake(proc);
  proc.send({ type: 'assistant', message: { content: [] } });

  for await (const _msg of q) break; // eslint-disable-line no-unused-vars
  assert.equal(proc.killed, true);
});
