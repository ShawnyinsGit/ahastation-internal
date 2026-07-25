import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { correlate } from '../dist-electron/observe/correlate.js';
import { associationKey, detectCodexDesktopHostPids } from '../dist-electron/observe/mapping.js';
import { mergeCodexDesktopSignals, ObserveService } from '../dist-electron/observe/observe-service.js';
import { findClientPids, parsePsOutput } from '../dist-electron/observe/process/darwin.js';
import {
  listCodexDesktopThreads,
  majorityChatCwd,
  parseCodexDesktopThread,
} from '../dist-electron/observe/statefiles/codex-desktop.js';
import { inferCodexDesktopState } from '../dist-electron/observe/state-machine.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'observe');
const HOME = join(FIXTURES, 'home');
const snapshot = parsePsOutput(readFileSync(join(FIXTURES, 'ps-sample.txt'), 'utf8'), 1_000);

const HOST_PID = 86693; // ChatGPT.app `codex ... app-server` in ps-sample
const BROKER_PID = 8601; // `codex app-server-broker` — NOT the desktop host
const CHAT_PID = 97611; // live chat-spawned osPid in ps-sample
const DESK_LIVE = 'e5de0000-0000-7000-8000-0000000000d1';
const DESK_IDLE = 'e5de0000-0000-7000-8000-0000000000d2';
const DESK_PROCS_ONLY = 'e5de0000-0000-7000-8000-0000000000d3';
const CLI_WITH_DESCRIPTION = 'd0de0000-0000-7000-8000-0000000000a3';

const identity = (p) => p;

async function loadDesktopSignals() {
  const threads = await listCodexDesktopThreads(HOME);
  return threads
    .map((thread) => parseCodexDesktopThread(thread))
    .filter((signal) => signal !== null);
}

function desktopCorrelate(signals, hostPid) {
  return correlate({
    signals,
    associations: new Map(),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set(),
    suppressedPaths: new Set(),
    codexDesktopHostPid: hostPid,
  });
}

// ---------------------------------------------------------------------------
// listCodexDesktopThreads: global-state ⨝ chat_processes join
// ---------------------------------------------------------------------------

test('desktop list: descriptions joined with chat processes by conversationId', async () => {
  const threads = await listCodexDesktopThreads(HOME);
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));
  // 3 desktop threads + the 2 CLI rollout ids that also carry descriptions
  // (the service dedups those against CLI rollout signals — see e2e below).
  assert.equal(byId.size, 5);

  const live = byId.get(DESK_LIVE);
  assert.equal(live.description, 'Review the desktop onboarding flow');
  assert.equal(live.processes.length, 2);
  assert.equal(live.heartbeat, true);
  assert.equal(live.unread, false);
  assert.equal(live.workspaceRoot, '/Users/test/work/project-delta');

  const idle = byId.get(DESK_IDLE);
  assert.equal(idle.description, '整理发布前检查清单');
  assert.equal(idle.processes.length, 1);
  assert.equal(idle.unread, true);
  assert.equal(idle.heartbeat, false);

  const procsOnly = byId.get(DESK_PROCS_ONLY);
  assert.equal(procsOnly.description, undefined);
  assert.equal(procsOnly.processes.length, 1);

  assert.equal(byId.has(CLI_WITH_DESCRIPTION), true);
});

// ---------------------------------------------------------------------------
// parseCodexDesktopThread: title chain, chat pids, cwd
// ---------------------------------------------------------------------------

test('desktop parse: description title, chat pids, majority cwd, badge flags', async () => {
  const threads = await listCodexDesktopThreads(HOME);
  const byId = new Map(threads.map((thread) => [thread.threadId, thread]));

  const live = parseCodexDesktopThread(byId.get(DESK_LIVE));
  assert.equal(live.clientKind, 'codex');
  assert.equal(live.nativeSessionId, DESK_LIVE);
  assert.equal(live.title, 'Review the desktop onboarding flow');
  assert.equal(live.titleSource, 'global-state');
  assert.equal(live.cwd, '/Users/test/work/project-alpha');
  assert.deepEqual(live.tailSignals.chatPids, [CHAT_PID, 55555]);
  assert.equal(live.tailSignals.lastChatUpdateAtMs, 1753300060000);
  assert.equal(live.tailSignals.heartbeat, true);
  assert.equal(live.tailSignals.unread, false);

  // No description → chatTitle from the process manager (index provenance);
  // osPid null is dropped from the pid list.
  const procsOnly = parseCodexDesktopThread(byId.get(DESK_PROCS_ONLY));
  assert.equal(procsOnly.title, 'Sketch the release checklist');
  assert.equal(procsOnly.titleSource, 'session-index');
  assert.deepEqual(procsOnly.tailSignals.chatPids, []);
});

test('majorityChatCwd: majority wins, ties keep first-seen, empty → undefined', () => {
  const proc = (cwd) => ({ cwd, updatedAtMs: 0 });
  assert.equal(majorityChatCwd([proc('/a'), proc('/b'), proc('/a')]), '/a');
  assert.equal(majorityChatCwd([proc('/a'), proc('/b')]), '/a');
  assert.equal(majorityChatCwd([{ updatedAtMs: 0 }]), undefined);
  assert.equal(majorityChatCwd([]), undefined);
});

test('desktop parse: process-less thread falls back to the workspace root; no cwd → null', () => {
  const ref = {
    threadId: 't1',
    filePath: '/f',
    mtimeMs: 1,
    sizeBytes: 1,
    unread: false,
    heartbeat: false,
    workspaceRoot: '/Users/test/work/project-delta',
    processes: [],
  };
  const signal = parseCodexDesktopThread(ref);
  assert.equal(signal.cwd, '/Users/test/work/project-delta');
  const { workspaceRoot, ...noRoot } = ref;
  assert.equal(parseCodexDesktopThread(noRoot), null);
});

// ---------------------------------------------------------------------------
// inferCodexDesktopState: the three outcomes
// ---------------------------------------------------------------------------

test('inferCodexDesktopState: live chat pid → executing; host only → idle; dead host → unknown', () => {
  assert.deepEqual(
    inferCodexDesktopState({ liveChatPids: [CHAT_PID], hostAlive: true }),
    { state: 'active', activity: 'executing' },
  );
  assert.deepEqual(
    inferCodexDesktopState({ liveChatPids: [], hostAlive: true }),
    { state: 'idle', activity: 'unknown' },
  );
  assert.deepEqual(
    inferCodexDesktopState({ liveChatPids: [], hostAlive: false }),
    { state: 'unknown', activity: 'unknown' },
  );
});

// ---------------------------------------------------------------------------
// CLI/Desktop split: no cross-claim in either direction
// ---------------------------------------------------------------------------

test('CLI/Desktop split: app-server host is detected, never a CLI candidate', () => {
  assert.deepEqual(detectCodexDesktopHostPids(snapshot), [HOST_PID]);
  const codexCliPids = findClientPids(snapshot, ['codex']);
  // The desktop host and the broker stay out of the CLI candidate list…
  assert.equal(codexCliPids.includes(HOST_PID), false);
  assert.equal(codexCliPids.includes(BROKER_PID), false);
  // …while genuine CLI processes are untouched.
  assert.deepEqual([...codexCliPids].sort((a, b) => a - b), [4301, 4302]);
});

// ---------------------------------------------------------------------------
// correlate: desktop rows
// ---------------------------------------------------------------------------

test('correlate desktop: live chat pid → active; dead chat pids + live host → host-backed idle', async () => {
  const signals = (await loadDesktopSignals())
    .filter((signal) => signal.nativeSessionId.startsWith('e5de'));
  assert.equal(signals.length, 3);
  const byId = new Map(desktopCorrelate(signals, HOST_PID).map((s) => [s.nativeSessionId, s]));
  assert.equal(byId.size, 3);

  const live = byId.get(DESK_LIVE);
  assert.equal(live.state, 'active');
  assert.equal(live.activity, 'executing');
  assert.equal(live.pid, CHAT_PID);
  assert.equal(live.title, 'Review the desktop onboarding flow');
  assert.equal(live.isNoise, false);
  assert.ok(live.evidence.includes(`chat-process pid ${CHAT_PID} alive`));
  assert.ok(live.evidence.includes(`desktop-host:app-server pid ${HOST_PID}`));
  assert.ok(live.evidence.includes('badge:heartbeat-perms'));

  const idle = byId.get(DESK_IDLE);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.pid, HOST_PID); // host-backed idle → board-visible
  assert.equal(idle.title, '整理发布前检查清单');
  assert.ok(idle.evidence.includes('badge:unread'));

  const procsOnly = byId.get(DESK_PROCS_ONLY);
  assert.equal(procsOnly.state, 'idle');
  assert.equal(procsOnly.pid, HOST_PID);
  assert.equal(procsOnly.title, 'Sketch the release checklist');
});

test('correlate desktop: dead host degrades host-idle threads to unknown; live chat pid stays active', async () => {
  const signals = (await loadDesktopSignals())
    .filter((signal) => signal.nativeSessionId.startsWith('e5de'));
  const byId = new Map(desktopCorrelate(signals, undefined).map((s) => [s.nativeSessionId, s]));

  // A live chat process owns its row even with the host gone (orphaned
  // children can outlive the app-server).
  assert.equal(byId.get(DESK_LIVE).state, 'active');
  assert.equal(byId.get(DESK_LIVE).pid, CHAT_PID);

  const idle = byId.get(DESK_IDLE);
  assert.equal(idle.state, 'unknown');
  assert.equal(idle.pid, undefined);
  assert.ok(idle.evidence.includes('desktop-host:app-server not running'));
  assert.equal(byId.get(DESK_PROCS_ONLY).state, 'unknown');
});

test('correlate desktop: lastActiveAt is max(global-state mtime, chat updatedAtMs)', () => {
  const base = {
    clientKind: 'codex',
    nativeSessionId: 't1',
    cwd: '/x',
    filePath: '/f',
    sizeBytes: 1,
    tailSignals: {
      kind: 'codex-desktop',
      chatPids: [],
      lastChatUpdateAtMs: 5_000,
      unread: false,
      heartbeat: false,
    },
  };
  const chatNewer = desktopCorrelate([{ ...base, mtimeMs: 1_000 }], HOST_PID);
  assert.equal(chatNewer[0].lastActiveAt, 5_000);
  const fileNewer = desktopCorrelate([{ ...base, mtimeMs: 9_000 }], HOST_PID);
  assert.equal(fileNewer[0].lastActiveAt, 9_000);
});

// ---------------------------------------------------------------------------
// mergeCodexDesktopSignals: CLI/Desktop dedup — one row per thread id
// ---------------------------------------------------------------------------

function cliSignal(id, mtimeMs) {
  return {
    clientKind: 'codex',
    nativeSessionId: id,
    cwd: '/x',
    filePath: '/r.jsonl',
    mtimeMs,
    sizeBytes: 1,
    tailSignals: {
      kind: 'codex',
      generating: false,
      pendingFunctionCalls: 0,
      sawTaskComplete: false,
      isExec: false,
      turnCount: 1,
    },
  };
}

function desktopSignal(id, lastChatUpdateAtMs, extra = {}) {
  return {
    clientKind: 'codex',
    nativeSessionId: id,
    cwd: '/x',
    filePath: '/g.json',
    mtimeMs: 1,
    sizeBytes: 1,
    tailSignals: {
      kind: 'codex-desktop',
      chatPids: [],
      lastChatUpdateAtMs,
      unread: false,
      heartbeat: false,
    },
    ...extra,
  };
}

test('mergeCodexDesktopSignals: one row per id; collisions keep BOTH sides (codex-merged)', () => {
  // Desktop-only and CLI-only ids pass through untouched.
  let merged = mergeCodexDesktopSignals([cliSignal('a', 100)], [desktopSignal('b', 50)]);
  assert.deepEqual(merged.map((s) => s.nativeSessionId).sort(), ['a', 'b']);
  assert.equal(merged[0].tailSignals.kind, 'codex');
  assert.equal(merged[1].tailSignals.kind, 'codex-desktop');

  // Collision → a single merged row carrying both tails whole; identity
  // fields stay on the CLI rollout (fd association + MCP suppression key on
  // it), display title seeds from the fresher side.
  merged = mergeCodexDesktopSignals(
    [{ ...cliSignal('a', 100), title: 'cli title', titleSource: 'session-index' }],
    [{ ...desktopSignal('a', 200), title: 'desktop title', titleSource: 'global-state' }],
  );
  assert.equal(merged.length, 1);
  const row = merged[0];
  assert.equal(row.tailSignals.kind, 'codex-merged');
  assert.equal(row.tailSignals.cli.kind, 'codex');
  assert.equal(row.tailSignals.desktop.kind, 'codex-desktop');
  assert.equal(row.tailSignals.cli.filePath, '/r.jsonl');
  assert.equal(row.tailSignals.desktop.filePath, '/g.json');
  assert.equal(row.filePath, '/r.jsonl'); // rollout path, never global-state
  assert.equal(row.title, 'desktop title'); // desktop chat updates are fresher
  assert.equal(row.titleSource, 'global-state');
  assert.equal(row.mtimeMs, 100); // max(cli.mtimeMs, desktop.mtimeMs=1)

  // CLI rollout fresher → CLI display fields win the seed.
  merged = mergeCodexDesktopSignals(
    [{ ...cliSignal('a', 300), title: 'cli title', titleSource: 'session-index' }],
    [{ ...desktopSignal('a', 200), title: 'desktop title', titleSource: 'global-state' }],
  );
  assert.equal(merged[0].title, 'cli title');
  assert.equal(merged[0].titleSource, 'session-index');

  // A desktop thread without chat-process updates never outranks a rollout —
  // the global-state mtime is app-wide and proves nothing per-thread.
  merged = mergeCodexDesktopSignals(
    [{ ...cliSignal('a', 1), title: 'cli title' }],
    [{ ...desktopSignal('a', 0), title: 'desktop title' }],
  );
  assert.equal(merged[0].title, 'cli title');

  // Fresher side without a title falls back to the other side's title.
  merged = mergeCodexDesktopSignals(
    [{ ...cliSignal('a', 100), title: 'cli title', titleSource: 'session-index' }],
    [desktopSignal('a', 200)],
  );
  assert.equal(merged[0].title, 'cli title');
});

// ---------------------------------------------------------------------------
// correlate: CLI↔desktop collision rows (the visibility-bug fix)
// ---------------------------------------------------------------------------

/** Build a merged collision row via the real merge, with tunable liveness
 * inputs: CLI rollout mtime + tail, desktop chat pids + chat recency. */
function mergedRow(id, {
  cliMtime,
  chatPids = [],
  lastChatUpdateAtMs = 0,
  cliTitle,
  desktopTitle,
  cliTail = {},
} = {}) {
  const cliBase = cliSignal(id, cliMtime);
  const cli = {
    ...cliBase,
    title: cliTitle,
    titleSource: cliTitle ? 'session-index' : undefined,
    tailSignals: { ...cliBase.tailSignals, ...cliTail },
  };
  const desktopBase = desktopSignal(id, lastChatUpdateAtMs);
  const desktop = {
    ...desktopBase,
    title: desktopTitle,
    titleSource: desktopTitle ? 'global-state' : undefined,
    tailSignals: { ...desktopBase.tailSignals, chatPids },
  };
  const [row] = mergeCodexDesktopSignals([cli], [desktop]);
  assert.equal(row.tailSignals.kind, 'codex-merged');
  return row;
}

function collisionCorrelate(signals, { hostPid, associations } = {}) {
  return correlate({
    signals,
    associations: associations ?? new Map(),
    snapshot,
    realpathOf: identity,
    now: Date.now(),
    selfSessionIds: new Set(),
    suppressedPaths: new Set(),
    codexDesktopHostPid: hostPid,
  });
}

test('collision: live desktop chat pid + stale CLI rollout → desktop rules, chat pid owns the row', () => {
  const row = mergedRow('c1', {
    cliMtime: Date.now() - 20 * 60_000, // stale rollout, nothing claims it
    chatPids: [CHAT_PID],
    lastChatUpdateAtMs: Date.now() - 60_000,
    cliTitle: 'old cli title',
    desktopTitle: '桌面窗口标题',
  });
  const [session] = collisionCorrelate([row], { hostPid: HOST_PID });
  assert.equal(session.state, 'active');
  assert.equal(session.activity, 'executing');
  assert.equal(session.pid, CHAT_PID);
  // The live side's title wins, and both files show up in evidence.
  assert.equal(session.title, '桌面窗口标题');
  assert.equal(session.titleSource, 'global-state');
  assert.ok(session.evidence.includes(`file:${row.tailSignals.cli.filePath}`));
  assert.ok(session.evidence.includes(`file:${row.tailSignals.desktop.filePath}`));
  assert.ok(session.evidence.includes(`chat-process pid ${CHAT_PID} alive`));
  // Board-visible: active rows always render.
  assert.equal(session.isNoise, false);
});

test('collision: live host + stale CLI rollout → host-backed idle (the reported bug)', () => {
  const row = mergedRow('c2', {
    cliMtime: Date.now() - 20 * 60_000, // newer than the desktop side yet stale
    chatPids: [],
    cliTitle: 'stale rollout title',
    desktopTitle: '桌面线程',
  });
  const [session] = collisionCorrelate([row], { hostPid: HOST_PID });
  // Before the fix the fresher CLI side won winner-take-all and the row
  // became a pidless idle → hidden while the desktop window was open.
  assert.equal(session.state, 'idle');
  assert.equal(session.pid, HOST_PID);
  assert.equal(session.title, '桌面线程');
  assert.ok(session.evidence.includes(`desktop-host:app-server pid ${HOST_PID}`));
});

test('collision: live CLI pid + dead desktop side → CLI rules win', () => {
  const row = mergedRow('c3', {
    cliMtime: Date.now() - 60_000,
    chatPids: [55555], // dead in ps-sample
    cliTitle: 'cli 会话标题',
    desktopTitle: '旧桌面线程',
    cliTail: { generating: true },
  });
  const associations = new Map([
    [associationKey('codex', 'c3'), { pid: 4301, via: 'cwd' }],
  ]);
  const [session] = collisionCorrelate([row], { associations }); // no host pid
  assert.equal(session.state, 'active');
  assert.equal(session.activity, 'thinking');
  assert.equal(session.pid, 4301);
  // CLI is the live side → its title wins.
  assert.equal(session.title, 'cli 会话标题');
  assert.equal(session.titleSource, 'session-index');
  assert.ok(session.evidence.includes('pid:4301 via cwd'));
  assert.ok(session.evidence.includes('desktop-host:app-server not running'));
});

test('collision: both sides stale → CLI-side stale outcome (idle pidless → hidden)', () => {
  const row = mergedRow('c4', {
    cliMtime: Date.now() - 20 * 60_000, // outside the done window
    chatPids: [55555],
    cliTitle: 'rollout 标题',
    desktopTitle: '桌面标题',
  });
  const [session] = collisionCorrelate([row], {}); // no host, no association
  assert.equal(session.state, 'idle');
  assert.equal(session.pid, undefined);
  // Recency tie-break: the rollout is fresher (no chat-process updates).
  assert.equal(session.title, 'rollout 标题');
  assert.ok(session.evidence.includes(`chat-process pid 55555 alive`) === false);

  // Fresher desktop side (recent chat update) wins the title tie-break.
  const desktopFresher = mergedRow('c5', {
    cliMtime: Date.now() - 20 * 60_000,
    lastChatUpdateAtMs: Date.now() - 5 * 60_000,
    cliTitle: 'rollout 标题',
    desktopTitle: '桌面标题',
  });
  const [session5] = collisionCorrelate([desktopFresher], {});
  assert.equal(session5.title, '桌面标题');
  assert.equal(session5.titleSource, 'global-state');
  assert.equal(session5.lastActiveAt, desktopFresher.tailSignals.desktop.lastChatUpdateAtMs);
});

test('correlate desktop: untitled non-active threads fold into noise; active or titled stay visible', () => {
  const untitled = desktopSignal('t1', 0);
  const idle = desktopCorrelate([untitled], HOST_PID);
  assert.equal(idle[0].state, 'idle');
  assert.equal(idle[0].isNoise, true);

  // A live chat pid keeps even an untitled row out of the noise group.
  const active = desktopCorrelate(
    [{ ...untitled, tailSignals: { ...untitled.tailSignals, chatPids: [CHAT_PID] } }],
    HOST_PID,
  );
  assert.equal(active[0].state, 'active');
  assert.equal(active[0].isNoise, false);

  // A curated title also keeps an idle row visible.
  const titled = desktopCorrelate(
    [{ ...untitled, title: 'Review the plan', titleSource: 'global-state' }],
    HOST_PID,
  );
  assert.equal(titled[0].isNoise, false);
});

// ---------------------------------------------------------------------------
// ObserveService end-to-end (fixture home, fake ps, no subprocess)
// ---------------------------------------------------------------------------

async function runDesktopService(options = {}) {
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

test('ObserveService: desktop threads publish; CLI rollout ids never duplicate as desktop rows', async () => {
  const snap = await runDesktopService();
  const codexIds = snap.sessions
    .filter((s) => s.clientKind === 'codex')
    .map((s) => s.nativeSessionId);
  // a2/a3 carry global-state descriptions AND CLI rollouts; each collision
  // merges into ONE row (codex-merged), so no id ever appears twice.
  assert.equal(new Set(codexIds).size, codexIds.length);

  const byId = new Map(snap.sessions.map((s) => [s.nativeSessionId, s]));
  assert.equal(byId.get(DESK_LIVE).state, 'active');
  assert.equal(byId.get(DESK_LIVE).pid, CHAT_PID);
  assert.equal(byId.get(DESK_IDLE).state, 'idle');
  assert.equal(byId.get(DESK_IDLE).pid, HOST_PID);

  // The colliding a3 row keeps its rollout evidence as the anchor AND gains
  // the live desktop host: host-backed idle, visible while ChatGPT.app runs
  // (the old winner-take-all dropped the host pid behind the fresher
  // rollout and the board hid the row).
  const cliRow = byId.get(CLI_WITH_DESCRIPTION);
  assert.match(cliRow.evidence[0], /rollout-.*\.jsonl$/);
  assert.equal(cliRow.state, 'idle');
  assert.equal(cliRow.pid, HOST_PID);
  assert.ok(cliRow.evidence.includes(`desktop-host:app-server pid ${HOST_PID}`));
});

test('ObserveService: self-excluded host pid drops host backing (own adapter children stay hidden)', async () => {
  const snap = await runDesktopService({
    getSelfExclusion: () => ({ pids: new Set([HOST_PID]), sessionIds: new Set() }),
  });
  const byId = new Map(snap.sessions.map((s) => [s.nativeSessionId, s]));
  // Host excluded → host-backed idle degrades to unknown (board hides it).
  assert.equal(byId.get(DESK_IDLE).state, 'unknown');
  assert.equal(byId.get(DESK_IDLE).pid, undefined);
  // The live chat pid is not excluded and still owns its row.
  assert.equal(byId.get(DESK_LIVE).state, 'active');
  assert.equal(byId.get(DESK_LIVE).pid, CHAT_PID);
});

// ---------------------------------------------------------------------------
// Degradation: missing / corrupt files
// ---------------------------------------------------------------------------

test('desktop scan: missing files → no threads; corrupt file → partial join survives', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'observe-desktop-empty-'));
  assert.deepEqual(await listCodexDesktopThreads(empty), []);

  const home = mkdtempSync(join(tmpdir(), 'observe-desktop-corrupt-'));
  mkdirSync(join(home, '.codex', 'process_manager'), { recursive: true });
  // Corrupt global-state + valid processes → processes alone produce threads.
  writeFileSync(join(home, '.codex', '.codex-global-state.json'), '{ not json');
  writeFileSync(
    join(home, '.codex', 'process_manager', 'chat_processes.json'),
    JSON.stringify([{ conversationId: 't1', cwd: '/x', osPid: 42, updatedAtMs: 7 }]),
  );
  const fromProcs = await listCodexDesktopThreads(home);
  assert.equal(fromProcs.length, 1);
  assert.equal(fromProcs[0].threadId, 't1');
  assert.equal(fromProcs[0].description, undefined);
  // The corrupt global-state still anchors the evidence path.
  assert.ok(fromProcs[0].filePath.endsWith('.codex-global-state.json'));

  // Valid global-state + corrupt processes → descriptions alone produce threads.
  writeFileSync(
    join(home, '.codex', '.codex-global-state.json'),
    JSON.stringify({ 'electron-persisted-atom-state': { 'thread-descriptions-v1': { t2: 'titled' } } }),
  );
  writeFileSync(join(home, '.codex', 'process_manager', 'chat_processes.json'), '{ nope');
  const fromDescriptions = await listCodexDesktopThreads(home);
  assert.equal(fromDescriptions.length, 1);
  assert.equal(fromDescriptions[0].threadId, 't2');
  assert.equal(fromDescriptions[0].description, 'titled');
});

test('ObserveService: home without codex desktop files publishes zero rows, never throws', async () => {
  const home = mkdtempSync(join(tmpdir(), 'observe-desktop-none-'));
  const snap = await runDesktopService({ homeDir: home });
  assert.equal(snap.sessions.length, 0);
});

// ---------------------------------------------------------------------------
// Board rule (renderer-side): the rule lives in src/components/TasksView.tsx
// and is covered here in the established renderer-test style (source-level
// assertions, see tests/renderer-task-inspector.test.mjs).
// ---------------------------------------------------------------------------

test('board rule: pid-backed idle is shown, pidless idle stays hidden', () => {
  const source = readFileSync(new URL('../src/components/TasksView.tsx', import.meta.url), 'utf8');
  assert.match(source, /case 'idle':\s*return session\.pid !== undefined \? 'active' : null;/);
});
