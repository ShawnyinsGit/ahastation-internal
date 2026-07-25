import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  associate,
  detectMcpServerPids,
  extractSessionIdFromCommand,
  loadClaudePidFiles,
  mcpHeldRolloutPaths,
} from '../dist-electron/observe/mapping.js';
import { parseLsofFieldOutput, parsePsOutput } from '../dist-electron/observe/process/darwin.js';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'observe');
const psText = readFileSync(join(FIXTURES, 'ps-sample.txt'), 'utf8');
const snapshot = parsePsOutput(psText, 1_000);

const NO_SELF = { pids: new Set(), sessionIds: new Set() };
const identity = (p) => p;

function signal(clientKind, nativeSessionId, cwd, filePath = '/unused') {
  return {
    clientKind,
    nativeSessionId,
    cwd,
    filePath,
    mtimeMs: 1,
    sizeBytes: 1,
    tailSignals: clientKind === 'claude-code'
      ? { kind: 'claude', trailingRealUser: false, unclosedToolUse: false, messagesSeen: 2 }
      : { kind: 'codex', generating: false, pendingFunctionCalls: 0, sawTaskComplete: false, isExec: false, turnCount: 1 },
  };
}

// ---------------------------------------------------------------------------
// extractSessionIdFromCommand
// ---------------------------------------------------------------------------

test('cmd-arg extraction: space and = forms for every supported flag', () => {
  const id = 'c1a0de00-0000-4000-8000-000000000001';
  assert.equal(extractSessionIdFromCommand(`/usr/local/bin/claude --resume ${id}`), id);
  assert.equal(extractSessionIdFromCommand(`/usr/local/bin/claude --resume=${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --session-id ${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --session-id=${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --resume-session-id=${id}`), id);
  assert.equal(extractSessionIdFromCommand(`claude --resume-session-id ${id}`), id);
  // codex resume <id> subcommand form
  assert.equal(extractSessionIdFromCommand(`/usr/local/bin/codex resume ${id}`), id);
  assert.equal(extractSessionIdFromCommand('/usr/local/bin/claude'), null);
  assert.equal(extractSessionIdFromCommand('claude --resume not-a-uuid'), null);
});

// ---------------------------------------------------------------------------
// Claude PID files
// ---------------------------------------------------------------------------

test('PID files: missing directory degrades to an empty map', async () => {
  const home = mkdtempSync(join(tmpdir(), 'observe-nopids-'));
  const map = await loadClaudePidFiles(home);
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// MCP suppression
// ---------------------------------------------------------------------------

test('MCP suppression: mcp-server pids detected, held rollouts collected', () => {
  const mcpPids = detectMcpServerPids(snapshot);
  assert.deepEqual(mcpPids, [4401]);
  const lsof = parseLsofFieldOutput(readFileSync(join(FIXTURES, 'lsof-sample.txt'), 'utf8'));
  const held = mcpHeldRolloutPaths(lsof, mcpPids);
  assert.equal(held.size, 2);
  for (const path of held) assert.match(path, /\.codex\/sessions\/.+\.jsonl$/);
});

// ---------------------------------------------------------------------------
// associate(): three fallbacks + self-exclusion
// ---------------------------------------------------------------------------

test('fallback 1: command-line session id wins', () => {
  const signals = [signal('claude-code', 'c1a0de00-0000-4000-8000-000000000001', '/somewhere/else')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201],
    signals,
    snapshot,
    lsofByPid: new Map(),
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get('c1a0de00-0000-4000-8000-000000000001'), { pid: 4201, via: 'cmd-args' });
});

test('fallback 2: PID file associates when cmd args do not', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000009';
  const signals = [signal('claude-code', sid, '/x')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201], // cmd line carries a DIFFERENT, unknown session id
    signals,
    snapshot,
    lsofByPid: new Map(),
    pidFileMap: new Map([[4201, { sessionId: sid, cwd: '/x' }]]),
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get(sid), { pid: 4201, via: 'pid-file' });
});

test('fallback 3a: cwd match associates via lsof cwd', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000010';
  const signals = [signal('claude-code', sid, '/Users/test/work/project-alpha')];
  const lsof = new Map([[4210, { cwd: '/Users/test/work/project-alpha', files: [] }]]);
  const map = associate({
    clientKind: 'claude-code',
    pids: [4210], // --resume id unknown to us → falls through to cwd
    signals,
    snapshot,
    lsofByPid: lsof,
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get(sid), { pid: 4210, via: 'cwd' });
});

test('fallback 3b: codex fd → rollout path', () => {
  const sid = 'd0de0000-0000-7000-8000-0000000000a1';
  const rollout = '/Users/test/.codex/sessions/2026/07/24/rollout-x-d0de0000-0000-7000-8000-0000000000a1.jsonl';
  const signals = [signal('codex', sid, '/elsewhere', rollout)];
  // lsof cwd does NOT match the signal cwd — only the open rollout fd can.
  const lsof = new Map([[4301, { cwd: '/unrelated', files: [rollout] }]]);
  const map = associate({
    clientKind: 'codex',
    pids: [4301],
    signals,
    snapshot,
    lsofByPid: lsof,
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get(sid), { pid: 4301, via: 'fd' });
});

test('self-exclusion: own pid never associates', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000001';
  const signals = [signal('claude-code', sid, '/x')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201],
    signals,
    snapshot,
    lsofByPid: new Map(),
    realpathOf: identity,
    selfExclusion: { pids: new Set([4201]), sessionIds: new Set() },
  });
  assert.equal(map.size, 0);
});

test('self-exclusion: own session id never associates', () => {
  const sid = 'c1a0de00-0000-4000-8000-000000000001';
  const signals = [signal('claude-code', sid, '/x')];
  const map = associate({
    clientKind: 'claude-code',
    pids: [4201],
    signals,
    snapshot,
    lsofByPid: new Map(),
    realpathOf: identity,
    selfExclusion: { pids: new Set(), sessionIds: new Set([sid]) },
  });
  assert.equal(map.size, 0);
});
