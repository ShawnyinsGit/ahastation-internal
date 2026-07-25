import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyTaskDispatchDefaults,
  detectSuggestedCommands,
  inferDefaultDependencyGate,
  inferTaskIntent,
  sandboxWritePath,
} from '../dist-electron/task-intent.js';

test('inferTaskIntent detects write, command, and network asks', () => {
  assert.deepEqual(inferTaskIntent('写一个 ping 文件'), {
    wantsWrite: true,
    wantsCommand: false,
    wantsNetwork: false,
    commandKinds: [],
  });
  assert.deepEqual(inferTaskIntent('跑测试'), {
    wantsWrite: false,
    wantsCommand: true,
    wantsNetwork: false,
    commandKinds: ['test'],
  });
  assert.deepEqual(inferTaskIntent('fix the login bug and run npm test'), {
    wantsWrite: true,
    wantsCommand: true,
    wantsNetwork: false,
    commandKinds: ['test'],
  });
  assert.deepEqual(inferTaskIntent('download the latest release notes'), {
    wantsWrite: false,
    wantsCommand: false,
    wantsNetwork: true,
    commandKinds: [],
  });
  assert.deepEqual(inferTaskIntent('解释一下这段代码在干什么'), {
    wantsWrite: false,
    wantsCommand: false,
    wantsNetwork: false,
    commandKinds: [],
  });
});

test('inferTaskIntent separates build and lint asks from tests', () => {
  assert.deepEqual(inferTaskIntent('帮我 build 一下').commandKinds, ['build']);
  assert.deepEqual(inferTaskIntent('先编译再跑测试').commandKinds, ['test', 'build']);
  assert.deepEqual(inferTaskIntent('run typecheck').commandKinds, ['lint']);
});

test('sandboxWritePath stays under .vibe-assets/tasks', () => {
  assert.equal(sandboxWritePath('ping-shared'), '.vibe-assets/tasks/ping-shared');
  assert.equal(sandboxWritePath('weird id!!'), '.vibe-assets/tasks/weird-id');
});

test('inferDefaultDependencyGate prefers reviewed for analysis and accepted for writers', () => {
  assert.equal(inferDefaultDependencyGate({
    workspaceMode: 'read-only',
    prompt: '解释登录流程',
  }), 'reviewed');
  assert.equal(inferDefaultDependencyGate({
    prompt: '解释一下这段代码在干什么',
  }), 'reviewed');
  assert.equal(inferDefaultDependencyGate({
    writePaths: ['src/auth.ts'],
    prompt: '解释登录流程',
  }), 'accepted');
  assert.equal(inferDefaultDependencyGate({
    prompt: '修复登录校验并补测试',
  }), 'accepted');
});

test('detectSuggestedCommands probes package managers and language markers', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-intent-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.deepEqual(detectSuggestedCommands(cwd), []);

  await writeFile(join(cwd, 'package.json'), '{"name":"demo"}\n');
  assert.deepEqual(detectSuggestedCommands(cwd), [['npm', 'test']]);
});

test('detectSuggestedCommands maps kinds onto real package.json scripts', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-scripts-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { build: 'vite build', typecheck: 'tsc --noEmit' } }),
  );

  // Asking for tests in a repo without a test script grants nothing bogus.
  assert.deepEqual(detectSuggestedCommands(cwd, ['test']), []);
  assert.deepEqual(detectSuggestedCommands(cwd, ['build']), [['npm', 'run', 'build']]);
  assert.deepEqual(detectSuggestedCommands(cwd, ['lint']), [['npm', 'run', 'typecheck']]);

  await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  assert.deepEqual(detectSuggestedCommands(cwd, ['build']), [['pnpm', 'run', 'build']]);
});

test('detectSuggestedCommands falls through to Makefile targets', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-make-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { build: 'vite build' } }),
  );
  await writeFile(join(cwd, 'Makefile'), 'PYTHON := python3\n\ntest:\n\t$(PYTHON) -m pytest\n');

  // package.json answers build; the missing test script falls through to make.
  assert.deepEqual(detectSuggestedCommands(cwd, ['build']), [['npm', 'run', 'build']]);
  assert.deepEqual(detectSuggestedCommands(cwd, ['test']), [['make', 'test']]);
});

test('detectSuggestedCommands covers go and cargo workspaces', async (t) => {
  const goCwd = await mkdtemp(join(tmpdir(), 'ahastation-go-'));
  const rustCwd = await mkdtemp(join(tmpdir(), 'ahastation-rust-'));
  t.after(() => Promise.all([
    rm(goCwd, { recursive: true, force: true }),
    rm(rustCwd, { recursive: true, force: true }),
  ]));

  await writeFile(join(goCwd, 'go.mod'), 'module demo\n');
  assert.deepEqual(detectSuggestedCommands(goCwd, ['test', 'build']), [
    ['go', 'test', './...'],
    ['go', 'build', './...'],
  ]);

  await writeFile(join(rustCwd, 'Cargo.toml'), '[package]\nname = "demo"\n');
  assert.deepEqual(detectSuggestedCommands(rustCwd, ['lint']), [['cargo', 'clippy']]);
});

test('applyTaskDispatchDefaults fills sandbox write path and detected commands', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-intent-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'package.json'), '{"name":"demo"}\n');

  const writeDefaults = applyTaskDispatchDefaults({
    id: 'ping',
    prompt: '写一句励志短句到文件',
    cwd,
    baselineKind: 'git-dirty',
  });
  assert.deepEqual(writeDefaults.writePaths, ['.vibe-assets/tasks/ping']);
  assert.equal(writeDefaults.workspaceMode, 'shared-locked');

  const testDefaults = applyTaskDispatchDefaults({
    id: 'run-tests',
    prompt: '跑测试',
    cwd,
    baselineKind: 'git-clean',
  });
  assert.deepEqual(testDefaults.commands, [['npm', 'test']]);
  assert.deepEqual(testDefaults.writePaths, ['.vibe-assets/tasks/run-tests']);
  assert.equal(testDefaults.workspaceMode, 'git-worktree');

  const explicit = applyTaskDispatchDefaults({
    id: 'auth',
    prompt: 'fix login',
    writePaths: ['src/auth'],
    workspaceMode: 'shared-locked',
    commands: [['npm', 'test', '--', 'auth']],
    cwd,
  });
  assert.deepEqual(explicit.writePaths, ['src/auth']);
  assert.equal(explicit.workspaceMode, 'shared-locked');
  assert.deepEqual(explicit.commands, [['npm', 'test', '--', 'auth']]);
});

test('applyTaskDispatchDefaults grants the asked-for command, not always test', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'ahastation-build-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', build: 'vite build' } }),
  );

  const buildDefaults = applyTaskDispatchDefaults({
    id: 'build-app',
    prompt: '帮我 build 一下这个项目',
    cwd,
    baselineKind: 'git-clean',
  });
  assert.deepEqual(buildDefaults.commands, [['npm', 'run', 'build']]);
  assert.equal(buildDefaults.diagnostic, 'intent-defaults-applied');
});
