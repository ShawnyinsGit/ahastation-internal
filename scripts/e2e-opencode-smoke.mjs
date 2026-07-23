#!/usr/bin/env node
// e2e-opencode-smoke.mjs — headless Phase 2 E2E smoke for the OpenCode backend.
//
// Runs the REAL adapter pipeline under plain node (no Electron GUI, no app
// storage): OpenCodeBackend.createSession → spawnOpencodeServer → SSE event
// stream → PermissionBroker → checkpoint-resync. The provider key comes from
// environment variables ONLY — never hardcoded, never read from settings.json
// / safeStorage:
//
//   export AHAMEET_E2E_API_KEY=sk-ant-...      # provider key (required)
//   export AHAMEET_E2E_PROVIDER=anthropic      # anthropic (default) | openai | kimi
//   export AHAMEET_E2E_MODEL=anthropic/claude-sonnet-4-5   # optional override
//   npm run build:electron && node scripts/e2e-opencode-smoke.mjs
//   # kimi = Kimi Code OpenAI 兼容端点（api.kimi.com/coding/v1），key 形如 sk-kimi-...
//
// Without AHAMEET_E2E_API_KEY the script prints SKIP guidance and exits 0.
// Every step prints a PASS/FAIL line; the exit code is 0 only when all pass.

import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

// ── Result ledger ───────────────────────────────────────────────────────────

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ── Step 0: provider key from env (graceful SKIP without it) ────────────────

const apiKey = process.env.AHAMEET_E2E_API_KEY?.trim();
// K3 是推理模型，单回合含 thinking + 工具 + 权限往返可达数分钟；超时给足
// （这是验收工具不是性能门），可用 env 覆盖。
const TURN_TIMEOUT_MS = Number(process.env.AHAMEET_E2E_TURN_TIMEOUT_MS ?? 300_000);
const provider = (process.env.AHAMEET_E2E_PROVIDER?.trim() || 'anthropic').toLowerCase();
// kimi = Kimi Code 的 OpenAI 兼容端点。注意模型必须以自定义 provider 形式
// 声明（adapter 的 deriveCustomProviderConfig 经 AHAMEET_OPENCODE_MODEL +
// KIMI_API_KEY/KIMI_BASE_URL 自动生成），否则 opencode 报 ProviderModelNotFoundError。
// 端点与模型名按官方文档：https://www.kimi.com/code/docs/en/
const PROVIDER_PRESETS = {
  anthropic: { model: 'anthropic/claude-sonnet-4-5', baseUrl: undefined, keyVar: 'ANTHROPIC_API_KEY', baseUrlVar: 'ANTHROPIC_BASE_URL' },
  openai: { model: 'openai/gpt-5.4', baseUrl: undefined, keyVar: 'OPENAI_API_KEY', baseUrlVar: 'OPENAI_BASE_URL' },
  kimi: { model: 'kimi/k3', baseUrl: 'https://api.kimi.com/coding/v1', keyVar: 'KIMI_API_KEY', baseUrlVar: 'KIMI_BASE_URL' },
};
const preset = PROVIDER_PRESETS[provider];

if (!apiKey) {
  console.log('SKIP  AHAMEET_E2E_API_KEY 未设置 — 跳过 E2E smoke（不影响构建/单测）。');
  console.log('');
  console.log('用法（macOS 实测）:');
  console.log('  export AHAMEET_E2E_API_KEY=sk-ant-...     # 或 OpenAI/Kimi key');
  console.log('  export AHAMEET_E2E_PROVIDER=anthropic      # anthropic(默认) | openai | kimi');
  console.log('  npm run build:electron && node scripts/e2e-opencode-smoke.mjs');
  process.exit(0);
}

const model = process.env.AHAMEET_E2E_MODEL?.trim() || preset?.model;
if (!model) {
  record('provider 识别', false, `未知 AHAMEET_E2E_PROVIDER='${provider}'，且未给 AHAMEET_E2E_MODEL`);
  process.exit(1);
}
console.log(`# provider=${provider} model=${model}（key 不打印）`);

// ── Imports (electron stub first — the adapter pulls in window-manager) ─────

const adapterPath = join(repoRoot, 'dist-electron/backends/opencode-adapter.js');
if (!existsSync(adapterPath)) {
  record('dist-electron 编译产物', false, '缺少 dist-electron/，先跑 npm run build:electron');
  process.exit(1);
}
register(pathToFileURL(join(repoRoot, 'tests/electron-stub.mjs')).href);
const { OpenCodeBackend } = await import(adapterPath);
const { resolveOpencodeBinary } = await import(
  join(repoRoot, 'dist-electron/backends/opencode-server-process.js')
);

// ── Event collector + wait helpers ──────────────────────────────────────────

const events = [];
let permissionUiCards = 0;   // broker degrade path (meeting-UI card)
let permissionNative = 0;    // broker destructive path (our confirmDestructive stub)
let authError = null;
const adapterErrors = [];

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolveWait) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (authError) {
        clearInterval(timer);
        resolveWait(false);
        return;
      }
      if (predicate()) {
        clearInterval(timer);
        resolveWait(true);
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        console.warn(`# waitFor 超时: ${label}`);
        resolveWait(false);
      }
    }, 100);
  });
}

function emit(event) {
  events.push(event);
  if (event.kind === 'permission-request') {
    permissionUiCards += 1;
    // Fallback path: answer the meeting-UI card (maps to opencode 'once').
    session?.resolvePermission(event.id, 'allow');
  }
  if (event.kind === 'auth-required') authError = event.error;
  if (event.kind === 'error') {
    adapterErrors.push(event.error);
    console.warn(`# adapter error event: ${event.error}`);
  }
}

// ── Main flow ───────────────────────────────────────────────────────────────

const backend = new OpenCodeBackend();
/** @type {import('../dist-electron/backends/cli-backend.js').BackendSession | null} */
let session = null;
let workdir = null;
let serverPid = null;

const watchdog = setTimeout(() => {
  console.error('FAIL  总超时（240s）— 强制退出');
  try { session?.end(); } catch { /* ignore */ }
  process.exit(1);
}, 240_000);

async function main() {
  // Step 1: binary resolvable (bundled opencode-<platform>-<arch>).
  const binary = resolveOpencodeBinary();
  record('opencode 二进制可解析', Boolean(binary), binary ?? 'opencode-darwin-arm64 未安装');
  if (!binary) return;

  // Step 2: buildEnv maps the settings-style key onto the provider env var.
  const env = backend.buildEnv({ authMode: 'apikey', apiKey, model, baseUrl: preset?.baseUrl });
  const expectedKeyVar = preset?.keyVar ?? 'ANTHROPIC_API_KEY';
  const expectedBaseUrlVar = preset?.baseUrlVar ?? 'ANTHROPIC_BASE_URL';
  const keyWired = env[expectedKeyVar] === apiKey;
  const baseUrlWired = !preset?.baseUrl || env[expectedBaseUrlVar] === preset.baseUrl;
  const modelHintWired = env.AHAMEET_OPENCODE_MODEL === model;
  record('buildEnv 把 key 接到 provider env', keyWired && baseUrlWired && modelHintWired,
    `${expectedKeyVar}${preset?.baseUrl ? ` + baseUrl=${preset.baseUrl}` : ''} + model=${model}`);
  if (!keyWired || !baseUrlWired || !modelHintWired) return;

  // Step 3: session start (spawn server, SSE subscribe-before-create).
  workdir = await mkdtemp(join(tmpdir(), 'ahastation-e2e-'));
  session = backend.createSession(
    {
      cwd: workdir,
      env,
      autoApproveScope: 'all',
      // Destructive tools (write/bash/…) reach the broker's native-confirm
      // path; our stub approves, which replies 'once' to the server.
      confirmDestructive: async () => { permissionNative += 1; return true; },
    },
    emit,
  );
  await session.start();
  const ready = await waitFor(
    () => events.some((e) => e.kind === 'message'
      && e.message?.type === 'system'
      && JSON.stringify(e.message).includes('会话已启动')),
    30_000,
    'session ready',
  );
  record('session 启动（spawn + SSE + create）', ready);
  if (!ready) return;
  serverPid = session.server?.pid ?? null; // runtime-only reach for the leak check

  // Step 4: prompt → text/tool/permission flow → turn done → file on disk.
  session.sendUserText(
    'Use the todowrite tool to record a short 2-step plan, then use the write tool '
    + 'to create a file named hello.txt whose entire content is: hi',
  );
  const turn1 = await waitFor(
    () => events.some((e) => e.kind === 'message' && e.message?.type === 'result'),
    TURN_TIMEOUT_MS,
    'turn 1 (session.idle)',
  );
  // session.idle also fires after a failed turn — require zero adapter error
  // events so a dead provider key can't masquerade as a completed turn.
  record('prompt 回合完成（session.idle 且无错误事件）', turn1 && adapterErrors.length === 0,
    adapterErrors[0] ?? authError ?? '');
  if (!turn1) return;

  let helloOk = false;
  try {
    const content = await readFile(join(workdir, 'hello.txt'), 'utf8');
    helloOk = /hi/.test(content);
  } catch { /* missing */ }
  record('hello.txt 落盘且内容正确', helloOk);

  // Step 5: permission.updated actually flowed and was answered ('once').
  // Native-confirm path counts our stub; UI-card path counts emit events.
  record(
    'permission.updated 出现且被答复（once）',
    permissionNative + permissionUiCards > 0,
    `native=${permissionNative} ui=${permissionUiCards}`,
  );

  // Step 6: editor panel state — diff non-empty + todos updated.
  const snapshot1 = session.getEditorSnapshot?.();
  record('session.diff 非空（编辑器 Diff 面板数据源）',
    Boolean(snapshot1 && snapshot1.diff.length > 0),
    `diff entries=${snapshot1?.diff?.length ?? 0}`);
  record('todo 更新（编辑器 Todo 面板数据源）',
    Boolean(snapshot1 && snapshot1.todos.length > 0),
    `todos=${snapshot1?.todos?.length ?? 0}`);

  // Step 7: kill the SSE fetch stream → adapter re-subscribes + resyncs.
  // Prompt 2 fires immediately so turn-2 events land inside the resync gap
  // (buffered, then merged against the snapshot — the spike §5 scenario).
  const resultCountBefore = events.filter(
    (e) => e.kind === 'message' && e.message?.type === 'result',
  ).length;
  console.log('# 主动断开事件流（预期出现一条 “event stream lost” 警告）…');
  session.streamAbort?.abort(); // runtime-only reach: simulate network drop
  session.sendUserText('Create a file named bye.txt whose entire content is: bye');
  const turn2 = await waitFor(
    () => events.filter((e) => e.kind === 'message' && e.message?.type === 'result').length
      > resultCountBefore,
    TURN_TIMEOUT_MS,
    'turn 2 after resync',
  );
  let byeOk = false;
  try {
    byeOk = /bye/.test(await readFile(join(workdir, 'bye.txt'), 'utf8'));
  } catch { /* missing */ }
  record('断流重连后回合完成且事件不丢（resync）', turn2 && byeOk);

  // Step 8: end() kills the server process (no orphan).
  session.end();
  let serverGone = true;
  if (serverPid) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        process.kill(serverPid, 0); // ESRCH when gone
        if (Date.now() > deadline) { serverGone = false; break; }
        await new Promise((r) => setTimeout(r, 100));
      } catch {
        break;
      }
    }
  }
  record('end() 后 server 进程退出（无孤儿）', serverGone, serverPid ? `pid=${serverPid}` : 'pid 未知');
}

try {
  await main();
} catch (err) {
  record('未捕获异常', false, String(err));
} finally {
  clearTimeout(watchdog);
  try { session?.end(); } catch { /* ignore */ }
  if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`# 汇总: ${results.length - failed.length}/${results.length} PASS`);
const authSuspect = authError
  ?? adapterErrors.find((e) => /api[- ]?key|auth|401|invalid/i.test(e));
if (authSuspect && failed.length > 0) {
  console.log(`# 疑似 provider 鉴权问题: ${authSuspect}（检查 AHAMEET_E2E_API_KEY / PROVIDER / MODEL）`);
}
process.exit(failed.length === 0 ? 0 : 1);
