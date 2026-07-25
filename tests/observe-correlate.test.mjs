import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { correlate } from '../dist-electron/observe/correlate.js';
import { associate, associationKey } from '../dist-electron/observe/mapping.js';
import { ObserveService } from '../dist-electron/observe/observe-service.js';
import { parsePsOutput } from '../dist-electron/observe/process/darwin.js';
import {
  listClaudeTranscripts,
  parseClaudeTranscript,
} from '../dist-electron/observe/statefiles/claude-projects.js';
import {
  listCodexRollouts,
  loadCodexTitles,
  parseCodexRollout,
} from '../dist-electron/observe/statefiles/codex-sessions.js';
import { redactSecrets, sanitizeTitle, sha1 } from '../dist-electron/observe/util.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'observe');
const HOME = join(FIXTURES, 'home');
const snapshot = parsePsOutput(readFileSync(join(FIXTURES, 'ps-sample.txt'), 'utf8'), 1_000);

const SID_IDLE = 'c1a0de00-0000-4000-8000-000000000001';
const SID_EXEC = 'c1a0de00-0000-4000-8000-000000000002';
const SID_NOISE = 'c1a0de00-0000-4000-8000-000000000003';
const CODEX_PENDING = 'd0de0000-0000-7000-8000-0000000000a1';
const CODEX_EXEC_DONE = 'd0de0000-0000-7000-8000-0000000000a2';
const CODEX_WAITING = 'd0de0000-0000-7000-8000-0000000000a3';

const identity = (p) => p;
const NO_SELF = { pids: new Set(), sessionIds: new Set() };

async function loadSignals() {
  const { titles, sources } = await loadCodexTitles(HOME);
  const claude = [];
  for (const ref of await listClaudeTranscripts(HOME)) {
    const signal = await parseClaudeTranscript(ref);
    if (signal) claude.push(signal);
  }
  const codex = [];
  for (const ref of await listCodexRollouts(HOME)) {
    const signal = await parseCodexRollout(ref, titles, sources);
    if (signal) codex.push(signal);
  }
  return { signals: [...claude, ...codex], claude, codex };
}

function associateAll(signals, selfExclusion = NO_SELF) {
  const associations = new Map();
  for (const kind of ['claude-code', 'codex']) {
    const clientSignals = signals.filter((s) => s.clientKind === kind);
    const map = associate({
      clientKind: kind,
      pids: kind === 'claude-code' ? [4201, 4210] : [4301, 4302],
      signals: clientSignals,
      snapshot,
      lsofByPid: new Map(),
      realpathOf: identity,
      selfExclusion,
    });
    for (const [sid, assoc] of map) associations.set(associationKey(kind, sid), assoc);
  }
  return associations;
}

// ---------------------------------------------------------------------------
// correlate end-to-end
// ---------------------------------------------------------------------------

test('correlate: full pipeline over the fixture tree', async () => {
  const { signals } = await loadSignals();
  assert.equal(signals.length, 6);
  const now = Date.now();
  const sessions = correlate({
    signals,
    associations: associateAll(signals),
    snapshot,
    realpathOf: identity,
    now,
    selfSessionIds: new Set(),
    suppressedPaths: new Set(),
  });
  const bySid = new Map(sessions.map((s) => [s.nativeSessionId, s]));
  assert.equal(bySid.size, 6);

  // Idle Claude with a live pid: synthetic tail → waiting, title redacted.
  const idle = bySid.get(SID_IDLE);
  assert.equal(idle.state, 'waiting');
  assert.equal(idle.activity, 'waiting');
  assert.equal(idle.pid, 4201);
  assert.equal(idle.title, 'use key [REDACTED] to fetch the build log');
  assert.equal(idle.titleSource, 'first-prompt');
  assert.equal(idle.projectName, 'project-alpha');
  assert.equal(idle.isNoise, false);
  assert.equal(idle.inferred, true);

  // Unclosed tool_use → executing.
  const executing = bySid.get(SID_EXEC);
  assert.equal(executing.state, 'active');
  assert.equal(executing.activity, 'executing');
  assert.equal(executing.pid, 4210);
  assert.equal(executing.title, 'run the full test suite and fix whatever fails');

  // tmp session without a live process → unknown + noise.
  const noise = bySid.get(SID_NOISE);
  assert.equal(noise.state, 'unknown');
  assert.equal(noise.isNoise, true);

  // Codex exec session: task_complete → done regardless of mtime.
  const execDone = bySid.get(CODEX_EXEC_DONE);
  assert.equal(execDone.state, 'done');
  assert.equal(execDone.title, '全局标题应胜过索引');
  assert.equal(execDone.titleSource, 'global-state');

  // Codex pending session claimed by `codex resume <id>` on pid 4302.
  const pending = bySid.get(CODEX_PENDING);
  assert.equal(pending.pid, 4302);
  assert.equal(pending.state, 'active');
  assert.equal(pending.activity, 'executing');
  assert.equal(pending.title, 'Investigate flaky tests (npm test)');

  // Global-state description supplies the title when no index entry exists.
  const waiting = bySid.get(CODEX_WAITING);
  assert.equal(waiting.title, '调研蓝牙切换模块');
  assert.equal(waiting.titleSource, 'global-state');

  // Identity: same cwd → same projectId; distinct session ids.
  assert.equal(bySid.get(SID_IDLE).projectId, bySid.get(CODEX_WAITING).projectId);
  assert.equal(bySid.get(SID_IDLE).projectId, sha1('/Users/test/work/project-alpha'));
  assert.notEqual(bySid.get(SID_IDLE).id, bySid.get(CODEX_WAITING).id);
  assert.equal(bySid.get(SID_IDLE).id.length, 40);
});

test('correlate: MCP-suppressed rollout paths are dropped', async () => {
  const { signals } = await loadSignals();
  const ghost = signals.find((s) => s.nativeSessionId === CODEX_PENDING);
  const sessions = correlate({
    signals,
    associations: new Map(),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set(),
    suppressedPaths: new Set([ghost.filePath]),
  });
  assert.equal(sessions.some((s) => s.nativeSessionId === CODEX_PENDING), false);
  assert.equal(sessions.length, 5);
});

test('correlate: self session ids are dropped', async () => {
  const { signals } = await loadSignals();
  const sessions = correlate({
    signals,
    associations: new Map(),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set([SID_EXEC]),
    suppressedPaths: new Set(),
  });
  assert.equal(sessions.some((s) => s.nativeSessionId === SID_EXEC), false);
});

// ---------------------------------------------------------------------------
// redaction / sanitization
// ---------------------------------------------------------------------------

test('redaction: secret shapes are masked', () => {
  assert.equal(redactSecrets('key sk-ant-api03-abcdef123'), 'key [REDACTED]');
  assert.equal(redactSecrets('key sk-proj-abcdef123'), 'key [REDACTED]');
  assert.equal(redactSecrets('token ghp_abcdefghijklmnop'), 'token [REDACTED]');
  assert.equal(redactSecrets('aws AKIAIOSFODNN7EXAMPLE'), 'aws [REDACTED]');
  assert.equal(redactSecrets('Authorization: Bearer abc.def-123'), 'Authorization: Bearer [REDACTED]');
});

test('sanitizeTitle: control chars + bidi overrides stripped, truncated', () => {
  assert.equal(sanitizeTitle('hello \u202eworld\u202c'), 'hello world');
  assert.equal(sanitizeTitle('line\nbreak\ttab'), 'line break tab');
  const long = 'x'.repeat(100);
  assert.equal(sanitizeTitle(long).length, 60);
  assert.ok(sanitizeTitle(long).endsWith('…'));
});

// ---------------------------------------------------------------------------
// ObserveService end-to-end (fixture home, fake ps, no subprocess)
// ---------------------------------------------------------------------------

async function runService(options = {}) {
  const published = [];
  const service = new ObserveService({
    homeDir: HOME,
    publish: (snap) => published.push(snap),
    now: () => Date.now(),
    snapshotProvider: async () => snapshot,
    // lsof must not run in tests; failure degrades to "cwd unknown".
    execImpl: async () => {
      throw new Error('no subprocess in tests');
    },
    realpathImpl: async (p) => p,
    ...options,
  });
  await service.tickOnce();
  service.stop();
  assert.equal(published.length, 1);
  return published[0];
}

test('ObserveService.tickOnce: publishes a full snapshot from the fixture home', async () => {
  const snap = await runService();
  assert.ok(snap.scannedAt > 0);
  const bySid = new Map(snap.sessions.map((s) => [s.nativeSessionId, s]));
  // 6 CLI/Claude rows + 3 Codex Desktop threads (the two CLI rollout ids
  // that also carry global-state descriptions are deduped, not duplicated).
  assert.equal(bySid.size, 9);
  assert.equal(bySid.get(SID_IDLE).state, 'waiting');
  assert.equal(bySid.get(SID_EXEC).activity, 'executing');
  assert.equal(bySid.get(CODEX_PENDING).pid, 4302);
  // Sorted by lastActiveAt descending.
  const mtimes = snap.sessions.map((s) => s.lastActiveAt);
  assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a));
});

test('ObserveService: self-exclusion by pid AND session id', async () => {
  const snap = await runService({
    getSelfExclusion: () => ({
      pids: new Set([4201]),
      sessionIds: new Set([CODEX_PENDING]),
    }),
  });
  const bySid = new Map(snap.sessions.map((s) => [s.nativeSessionId, s]));
  // Own session id → gone entirely.
  assert.equal(bySid.has(CODEX_PENDING), false);
  // Own pid → no association; file-only evidence degrades to unknown.
  assert.equal(bySid.get(SID_IDLE).pid, undefined);
  assert.equal(bySid.get(SID_IDLE).state, 'unknown');
});

// ---------------------------------------------------------------------------
// regression: live-session noise exemption + path-like title rejection
// ---------------------------------------------------------------------------

test('correlate: live sessions with <2 messages are not noise; path-like titles fall back', async () => {
  const { signals } = await loadSignals();
  const tweaked = signals.map((s) => {
    if (s.nativeSessionId === SID_IDLE) {
      return { ...s, tailSignals: { ...s.tailSignals, messagesSeen: 1 } };
    }
    if (s.nativeSessionId === CODEX_EXEC_DONE) {
      return { ...s, title: '/Users/test/work/project-alpha' };
    }
    return s;
  });
  const sessions = correlate({
    signals: tweaked,
    associations: associateAll(tweaked),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set(),
    suppressedPaths: new Set(),
  });
  const bySid = new Map(sessions.map((s) => [s.nativeSessionId, s]));
  // Live pid + short transcript → still board-worthy, not noise-folded.
  assert.equal(bySid.get(SID_IDLE).isNoise, false);
  // Absolute path pasted as title → project+time fallback, never a raw path.
  const exec = bySid.get(CODEX_EXEC_DONE);
  assert.equal(exec.titleSource, 'project-fallback');
  assert.ok(!exec.title.startsWith('/'));
  assert.ok(exec.title.startsWith(`${exec.projectName} · `));
});
