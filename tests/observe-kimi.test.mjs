import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { correlate } from '../dist-electron/observe/correlate.js';
import { associate, associationKey } from '../dist-electron/observe/mapping.js';
import { ObserveService } from '../dist-electron/observe/observe-service.js';
import { parseLsofFieldOutput, parsePsOutput } from '../dist-electron/observe/process/darwin.js';
import {
  analyzeKimiLogTail,
  listKimiSessions,
  loadKimiSessionIndex,
  parseKimiSession,
  parseKimiStateJson,
} from '../dist-electron/observe/statefiles/kimi-sessions.js';
import { inferKimiState } from '../dist-electron/observe/state-machine.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'observe');
const HOME = join(FIXTURES, 'home');
const KIMI_HOME = join(HOME, '.kimi-code');
const snapshot = parsePsOutput(readFileSync(join(FIXTURES, 'ps-sample.txt'), 'utf8'), 1_000);
const lsofText = readFileSync(join(FIXTURES, 'lsof-sample.txt'), 'utf8');

const KIMI_TITLED = 'session_e1a00000-0000-4000-8000-0000000000b1';
const KIMI_PROMPT = 'session_e1a00000-0000-4000-8000-0000000000b2';
const KIMI_ORPHAN = 'session_e1a00000-0000-4000-8000-0000000000b3';
const LAST_PROMPT =
  'refactor the tokenizer pipeline so tokens stream end to end without any batching delays';

const identity = (p) => p;
const NO_SELF = { pids: new Set(), sessionIds: new Set() };

// The fixture index uses /Users/test/.kimi-code paths (real on-disk shape);
// resolving them requires a home whose sessions root actually exists, so
// each test gets a tmp home: fixture tree copied, index prefix rewritten.
function makeKimiHome() {
  const home = mkdtempSync(join(tmpdir(), 'observe-kimi-'));
  cpSync(join(KIMI_HOME, 'sessions'), join(home, '.kimi-code', 'sessions'), { recursive: true });
  cpSync(join(KIMI_HOME, 'workspaces.json'), join(home, '.kimi-code', 'workspaces.json'));
  const index = readFileSync(join(KIMI_HOME, 'session_index.jsonl'), 'utf8')
    .replaceAll('/Users/test/.kimi-code', join(home, '.kimi-code'));
  writeFileSync(join(home, '.kimi-code', 'session_index.jsonl'), index);
  // Deterministic order: b1's state.json is the newest (sort key).
  const stateB1 = join(
    home, '.kimi-code', 'sessions',
    'wd_project-alpha_a1b2c3d4e5f6', KIMI_TITLED, 'state.json',
  );
  const stateB2 = join(
    home, '.kimi-code', 'sessions',
    'wd_project-beta_b2c3d4e5f6a7', KIMI_PROMPT, 'state.json',
  );
  utimesSync(stateB1, new Date(2_000), new Date(2_000));
  utimesSync(stateB2, new Date(1_000), new Date(1_000));
  return home;
}

function kimiSignal(nativeSessionId, cwd, extra = {}) {
  return {
    clientKind: 'kimi',
    nativeSessionId,
    cwd,
    filePath: '/unused',
    mtimeMs: 1,
    sizeBytes: 1,
    tailSignals: { kind: 'kimi', inFlightRequest: false, lastEventAtMs: 0, messagesSeen: 2 },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// session_index.jsonl → session refs
// ---------------------------------------------------------------------------

test('kimi index: containment rejects sessionDirs outside ~/.kimi-code/sessions', async () => {
  // The static fixture index points at /Users/test/.kimi-code — foreign to
  // the fixture home, so every line is refused (fail-closed).
  const entries = await loadKimiSessionIndex(HOME);
  assert.equal(entries.length, 0);
});

test('listKimiSessions: dedupe, corrupt lines skipped, missing state.json skipped', async () => {
  const home = makeKimiHome();
  const refs = await listKimiSessions(home);
  assert.equal(refs.length, 2);
  // Newest state.json mtime first, so the cwd fallback picks it up first.
  assert.equal(refs[0].sessionId, KIMI_TITLED);
  assert.equal(refs[1].sessionId, KIMI_PROMPT);
  // The third index session (b3) has no state.json on disk → skipped; the
  // /etc escape line is rejected by containment; the dupe b1 collapsed.
  assert.equal(refs.some((ref) => ref.sessionId === KIMI_ORPHAN), false);
  assert.equal(new Set(refs.map((ref) => ref.sessionId)).size, refs.length);
  for (const ref of refs) {
    assert.ok(ref.filePath.endsWith('state.json'));
    assert.ok(ref.logPath.endsWith(join('logs', 'kimi-code.log')));
    assert.ok(ref.mtimeMs > 0);
  }
});

// ---------------------------------------------------------------------------
// parseKimiSession: title chain + log tail
// ---------------------------------------------------------------------------

test('kimi parse: state.json title wins, provenance session-index', async () => {
  const home = makeKimiHome();
  const refs = await listKimiSessions(home);
  const signal = await parseKimiSession(refs.find((ref) => ref.sessionId === KIMI_TITLED));
  assert.equal(signal.clientKind, 'kimi');
  assert.equal(signal.nativeSessionId, KIMI_TITLED);
  assert.equal(signal.cwd, '/Users/test/work/project-alpha');
  assert.equal(signal.title, 'Fix the onboarding crash on launch');
  assert.equal(signal.titleSource, 'session-index');
  // Trailing line is a response (+ a plain log line) → nothing in flight.
  assert.equal(signal.tailSignals.inFlightRequest, false);
  assert.equal(signal.tailSignals.messagesSeen, 2);
  assert.equal(signal.tailSignals.lastEventAtMs, Date.parse('2026-07-24T10:30:00.000Z'));
});

test('kimi parse: empty title falls back to lastPrompt (60 chars), first-prompt provenance', async () => {
  const home = makeKimiHome();
  const refs = await listKimiSessions(home);
  const signal = await parseKimiSession(refs.find((ref) => ref.sessionId === KIMI_PROMPT));
  assert.equal(signal.title, LAST_PROMPT.slice(0, 60));
  assert.equal(signal.title.length, 60);
  assert.equal(signal.titleSource, 'first-prompt');
  // Trailing `llm request` with no later response → generation in flight.
  assert.equal(signal.tailSignals.inFlightRequest, true);
  assert.equal(signal.tailSignals.messagesSeen, 2);
});

test('kimi parse: corrupt state.json degrades to null', async () => {
  const home = makeKimiHome();
  const refs = await listKimiSessions(home);
  const ref = refs.find((r) => r.sessionId === KIMI_TITLED);
  writeFileSync(ref.filePath, '{ not json');
  const signal = await parseKimiSession(ref);
  assert.equal(signal, null);
});

test('parseKimiStateJson: fields + updatedAt parsed, garbage tolerated', () => {
  const info = parseKimiStateJson(JSON.stringify({
    createdAt: '2026-07-24T09:00:00.000Z',
    updatedAt: '2026-07-24T10:30:00.000Z',
    title: 't',
    workDir: '/x',
    lastPrompt: 'p',
  }));
  assert.equal(info.title, 't');
  assert.equal(info.workDir, '/x');
  assert.equal(info.updatedAtMs, Date.parse('2026-07-24T10:30:00.000Z'));
  assert.equal(parseKimiStateJson('{ not json'), null);
  assert.equal(parseKimiStateJson(''), null);
});

// ---------------------------------------------------------------------------
// analyzeKimiLogTail
// ---------------------------------------------------------------------------

test('analyzeKimiLogTail: trailing request is in-flight, response clears it', () => {
  const request = '2026-07-24T12:00:00.000Z INFO  llm request  turnStep=0.1 agentId=main';
  const response = '2026-07-24T12:00:05.000Z INFO  llm response  turnStep=0/1 outputTokens=42 agentId=main';
  const inFlight = analyzeKimiLogTail([request, response, request]);
  assert.equal(inFlight.inFlightRequest, true);
  assert.equal(inFlight.messagesSeen, 1);
  assert.equal(inFlight.lastEventAtMs, Date.parse('2026-07-24T12:00:05.000Z'));
  const done = analyzeKimiLogTail([request, response]);
  assert.equal(done.inFlightRequest, false);
  const empty = analyzeKimiLogTail([]);
  assert.equal(empty.inFlightRequest, false);
  assert.equal(empty.lastEventAtMs, 0);
  assert.equal(empty.messagesSeen, 0);
});

// ---------------------------------------------------------------------------
// inferKimiState
// ---------------------------------------------------------------------------

test('inferKimiState: dead drops, none is unknown, live follows cpu/in-flight', () => {
  const tail = { kind: 'kimi', inFlightRequest: false, lastEventAtMs: 0, messagesSeen: 2 };
  assert.equal(inferKimiState({ tail, descendantCpuMax: 0, pidState: 'dead' }), null);
  assert.deepEqual(
    inferKimiState({ tail, descendantCpuMax: 0, pidState: 'none' }),
    { state: 'unknown', activity: 'unknown' },
  );
  assert.deepEqual(
    inferKimiState({ tail, descendantCpuMax: 12, pidState: 'live' }),
    { state: 'active', activity: 'executing' },
  );
  assert.deepEqual(
    inferKimiState({ tail: { ...tail, inFlightRequest: true }, descendantCpuMax: 0, pidState: 'live' }),
    { state: 'active', activity: 'thinking' },
  );
  // Executing evidence wins over an in-flight request (mirrors Claude).
  assert.deepEqual(
    inferKimiState({ tail: { ...tail, inFlightRequest: true }, descendantCpuMax: 9, pidState: 'live' }),
    { state: 'active', activity: 'executing' },
  );
  assert.deepEqual(
    inferKimiState({ tail, descendantCpuMax: 0, pidState: 'live' }),
    { state: 'waiting', activity: 'waiting' },
  );
});

// ---------------------------------------------------------------------------
// cwd-only association
// ---------------------------------------------------------------------------

test('kimi association: cwd-only, newest session in a shared workDir wins', () => {
  const cwd = '/Users/test/work/project-alpha';
  // Signals arrive newest-first (listKimiSessions sorts by state.json mtime).
  const signals = [kimiSignal(KIMI_TITLED, cwd), kimiSignal(KIMI_ORPHAN, cwd)];
  const lsofByPid = new Map([[5101, { cwd, files: [] }]]);
  const map = associate({
    clientKind: 'kimi',
    pids: [5101],
    signals,
    snapshot,
    lsofByPid,
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.deepEqual(map.get(KIMI_TITLED), { pid: 5101, via: 'cwd' });
  assert.equal(map.has(KIMI_ORPHAN), false);
});

test('kimi association: live pids outnumbering sessions stay unassociated', () => {
  const cwd = '/Users/test/work/project-alpha';
  const signals = [kimiSignal(KIMI_TITLED, cwd)];
  const lsofByPid = new Map([
    [5101, { cwd, files: [] }],
    [5199, { cwd, files: [] }],
  ]);
  const map = associate({
    clientKind: 'kimi',
    pids: [5101, 5199],
    signals,
    snapshot,
    lsofByPid,
    realpathOf: identity,
    selfExclusion: NO_SELF,
  });
  assert.equal(map.size, 1);
  assert.deepEqual(map.get(KIMI_TITLED), { pid: 5101, via: 'cwd' });
});

test('kimi association: self-excluded pid never associates', () => {
  const cwd = '/Users/test/work/project-alpha';
  const signals = [kimiSignal(KIMI_TITLED, cwd)];
  const lsofByPid = new Map([[5101, { cwd, files: [] }]]);
  const map = associate({
    clientKind: 'kimi',
    pids: [5101],
    signals,
    snapshot,
    lsofByPid,
    realpathOf: identity,
    selfExclusion: { pids: new Set([5101]), sessionIds: new Set() },
  });
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// correlate integration
// ---------------------------------------------------------------------------

async function loadKimiSignals(home) {
  const signals = [];
  for (const ref of await listKimiSessions(home)) {
    const signal = await parseKimiSession(ref);
    if (signal) signals.push(signal);
  }
  return signals;
}

function associateKimi(signals, selfExclusion = NO_SELF) {
  const lsofByPid = parseLsofFieldOutput(lsofText);
  const map = associate({
    clientKind: 'kimi',
    pids: [5101, 5102, 5199],
    signals,
    snapshot,
    lsofByPid,
    realpathOf: identity,
    selfExclusion,
  });
  const associations = new Map();
  for (const [sid, assoc] of map) associations.set(associationKey('kimi', sid), assoc);
  return associations;
}

test('correlate: kimi rows — titles, states, noise, unknown without pid', async () => {
  const home = makeKimiHome();
  const signals = await loadKimiSignals(home);
  assert.equal(signals.length, 2);
  const sessions = correlate({
    signals,
    associations: associateKimi(signals),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set(),
    suppressedPaths: new Set(),
  });
  const bySid = new Map(sessions.map((s) => [s.nativeSessionId, s]));

  const titled = bySid.get(KIMI_TITLED);
  assert.equal(titled.pid, 5101);
  assert.equal(titled.state, 'waiting');
  assert.equal(titled.activity, 'waiting');
  assert.equal(titled.title, 'Fix the onboarding crash on launch');
  assert.equal(titled.titleSource, 'session-index');
  assert.equal(titled.projectName, 'project-alpha');
  assert.equal(titled.isNoise, false);
  assert.equal(titled.inferred, true);

  // Live pid + in-flight request → thinking; lastPrompt title sanitized.
  const prompt = bySid.get(KIMI_PROMPT);
  assert.equal(prompt.pid, 5102);
  assert.equal(prompt.state, 'active');
  assert.equal(prompt.activity, 'thinking');
  assert.equal(prompt.titleSource, 'first-prompt');
  assert.ok(prompt.title.startsWith('refactor the tokenizer pipeline'));

  // No association → file-only evidence degrades to unknown.
  const noPid = correlate({
    signals,
    associations: new Map(),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set(),
    suppressedPaths: new Set(),
  });
  const orphan = new Map(noPid.map((s) => [s.nativeSessionId, s]));
  assert.equal(orphan.get(KIMI_TITLED).state, 'unknown');
  assert.equal(orphan.get(KIMI_TITLED).pid, undefined);

  // <2 messages and nothing live → noise-folded.
  const quiet = signals.map((s) => s.nativeSessionId === KIMI_TITLED
    ? { ...s, tailSignals: { ...s.tailSignals, messagesSeen: 1 } }
    : s);
  const noisy = correlate({
    signals: quiet,
    associations: new Map(),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set(),
    suppressedPaths: new Set(),
  });
  assert.equal(new Map(noisy.map((s) => [s.nativeSessionId, s])).get(KIMI_TITLED).isNoise, true);
});

// ---------------------------------------------------------------------------
// ObserveService end-to-end (tmp kimi home, fake ps + lsof)
// ---------------------------------------------------------------------------

test('ObserveService.tickOnce: kimi sessions with cwd-associated pids', async () => {
  const home = makeKimiHome();
  const published = [];
  const service = new ObserveService({
    homeDir: home,
    publish: (snap) => published.push(snap),
    now: () => Date.now(),
    snapshotProvider: async () => snapshot,
    execImpl: async (cmd) => {
      if (cmd === 'lsof') return { stdout: lsofText, stderr: '' };
      throw new Error('no ps in tests');
    },
    realpathImpl: async (p) => p,
  });
  await service.tickOnce();
  service.stop();
  assert.equal(published.length, 1);
  const bySid = new Map(published[0].sessions.map((s) => [s.nativeSessionId, s]));
  assert.equal(bySid.size, 2);
  assert.equal(bySid.get(KIMI_TITLED).pid, 5101);
  assert.equal(bySid.get(KIMI_TITLED).state, 'waiting');
  assert.equal(bySid.get(KIMI_PROMPT).pid, 5102);
  assert.equal(bySid.get(KIMI_PROMPT).state, 'active');
  assert.equal(bySid.get(KIMI_PROMPT).activity, 'thinking');
  assert.equal(bySid.get(KIMI_TITLED).clientKind, 'kimi');
});

test('ObserveService: self-exclusion by pid degrades kimi to unknown', async () => {
  const home = makeKimiHome();
  const published = [];
  const service = new ObserveService({
    homeDir: home,
    publish: (snap) => published.push(snap),
    now: () => Date.now(),
    snapshotProvider: async () => snapshot,
    execImpl: async (cmd) => {
      if (cmd === 'lsof') return { stdout: lsofText, stderr: '' };
      throw new Error('no ps in tests');
    },
    realpathImpl: async (p) => p,
    getSelfExclusion: () => ({ pids: new Set([5101]), sessionIds: new Set([KIMI_PROMPT]) }),
  });
  await service.tickOnce();
  service.stop();
  const bySid = new Map(published[0].sessions.map((s) => [s.nativeSessionId, s]));
  // Own session id → gone entirely.
  assert.equal(bySid.has(KIMI_PROMPT), false);
  // Own pid → no association; file-only evidence degrades to unknown.
  assert.equal(bySid.get(KIMI_TITLED).pid, undefined);
  assert.equal(bySid.get(KIMI_TITLED).state, 'unknown');
});
