import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalExecutionRequestSchema,
} from '../dist-electron/backends/canonical-execution.js';
import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { CodexBackend } from '../dist-electron/backends/codex-adapter.js';
import { KimiBackend } from '../dist-electron/backends/kimi-adapter.js';
import { OpenCodeBackend } from '../dist-electron/backends/opencode-adapter.js';
import { QoderBackend } from '../dist-electron/backends/qoder-adapter.js';
import { CustomBackend } from '../dist-electron/backends/custom-adapter.js';

const workers = [
  ['claude-code', new ClaudeCodeBackend()],
  ['codex', new CodexBackend()],
  ['opencode', new OpenCodeBackend()],
  ['kimi', new KimiBackend()],
];

function native(backendId, toolName, input, id = 'native-1') {
  return {
    taskId: 'task-login',
    backendId,
    workspaceRoot: '/workspace',
    nativeRequestId: id,
    toolName,
    input,
  };
}

for (const [backendId, backend] of workers) {
  test(`${backendId} normalizes source reads and workspace writes`, () => {
    const read = backend.normalizePermissionRequest(
      native(backendId, 'Read', { file_path: 'src/login.ts' }),
    );
    assert.equal(read.ok, true);
    assert.equal(read.request.kind, 'read');
    assert.deepEqual(read.request.writePaths, []);

    const write = backend.normalizePermissionRequest(
      native(backendId, 'Edit', { file_path: 'src/login.ts' }, 'native-2'),
    );
    assert.equal(write.ok, true);
    assert.equal(write.request.kind, 'write');
    assert.deepEqual(write.request.writePaths, ['src/login.ts']);
    assert.deepEqual(write.request.sideEffects, ['workspace-write']);
  });

  test(`${backendId} preserves exact executable argv and strips environment values`, () => {
    const result = backend.normalizePermissionRequest(native(backendId, 'Bash', {
      executable: 'npm',
      argv: ['test', '--', 'auth'],
      cwd: 'packages/app',
      timeoutMs: 120_000,
      env: {
        NODE_ENV: 'test',
        API_KEY: 'never-persist-this',
      },
      rawPayload: {
        authorization: 'Bearer secret',
      },
    }));
    assert.equal(result.ok, true);
    assert.equal(result.request.executable, 'npm');
    assert.deepEqual(result.request.argv, ['test', '--', 'auth']);
    assert.equal(result.request.cwd, 'packages/app');
    assert.equal(result.request.timeoutMs, 120_000);
    assert.deepEqual(result.request.environmentKeys, ['API_KEY', 'NODE_ENV']);
    assert.ok(result.request.sideEffects.includes('process'));
    assert.ok(result.request.sideEffects.includes('credential-access'));
    assert.doesNotMatch(JSON.stringify(result.request), /never-persist-this|Bearer secret/);
  });

  test(`${backendId} rejects opaque shell text instead of rebuilding a command`, () => {
    const result = backend.normalizePermissionRequest(
      native(backendId, 'Bash', { command: 'npm test && curl https://example.com' }),
    );
    assert.deepEqual(result, {
      ok: false,
      diagnostic: 'opaque-shell-command',
      requiresUser: true,
    });
  });
}

test('Codex preserves an array command boundary without joining shell text', () => {
  const result = new CodexBackend().normalizePermissionRequest(
    native('codex', 'Bash', {
      command: ['git', 'status', '--short'],
      cwd: '/workspace',
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.request.executable, 'git');
  assert.deepEqual(result.request.argv, ['status', '--short']);
});

test('explicit shell wrappers preserve argv and are marked opaque-shell', () => {
  const result = new CodexBackend().normalizePermissionRequest(
    native('codex', 'Bash', {
      executable: 'sh',
      argv: ['-lc', 'npm test && npm run build'],
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.request.executable, 'sh');
  assert.deepEqual(result.request.argv, ['-lc', 'npm test && npm run build']);
  assert.ok(result.request.sideEffects.includes('opaque-shell'));
});

test('network and external-service facts are explicit', () => {
  const backend = new ClaudeCodeBackend();
  const network = backend.normalizePermissionRequest(
    native('claude-code', 'WebFetch', { url: 'https://docs.example.com/a?token=secret' }),
  );
  assert.equal(network.ok, true);
  assert.equal(network.request.kind, 'network');
  assert.deepEqual(network.request.networkHosts, ['docs.example.com']);
  assert.doesNotMatch(JSON.stringify(network.request), /token=secret/);

  const external = backend.normalizePermissionRequest(
    native('claude-code', 'mcp__github__create_issue', { owner: 'a', repo: 'b' }),
  );
  assert.equal(external.ok, true);
  assert.equal(external.request.kind, 'external');
  assert.deepEqual(external.request.sideEffects, ['external-service']);
});

test('high-risk command facts are classified without executing anything', () => {
  const backend = new CodexBackend();
  const destructive = backend.normalizePermissionRequest(native('codex', 'Bash', {
    command: ['git', 'push', '--force', 'origin', 'main'],
  }));
  assert.equal(destructive.ok, true);
  assert.ok(destructive.request.sideEffects.includes('destructive-git'));

  const adminInstall = backend.normalizePermissionRequest(native('codex', 'Bash', {
    executable: 'sudo',
    argv: ['apt-get', 'install', 'pkg'],
  }, 'native-admin'));
  assert.equal(adminInstall.ok, true);
  assert.ok(adminInstall.request.sideEffects.includes('administrator'));
  assert.ok(adminInstall.request.sideEffects.includes('system-install'));
});

test('native request identity is stable and raw native payload is excluded', () => {
  const backend = new OpenCodeBackend();
  const input = native('opencode', 'Edit', {
    filePath: 'src/a.ts',
    metadata: { diff: 'secret native diff' },
  }, 'permission-77');
  const first = backend.normalizePermissionRequest(input);
  const second = backend.normalizePermissionRequest(structuredClone(input));
  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.equal(first.request.nativeRequestId, 'permission-77');
  assert.equal('metadata' in first.request, false);
  assert.doesNotMatch(JSON.stringify(first.request), /secret native diff/);
});

test('secret-bearing argv fails closed instead of persisting a redacted command', () => {
  const backend = new CodexBackend();
  for (const input of [
    { command: ['curl', '--authorization', 'Bearer never-store-this'] },
    { command: ['tool', '--api-key=never-store-this'] },
    { command: ['curl', 'https://user:password@example.com/path'] },
    { command: ['curl', 'https://example.com/path?token=never-store-this'] },
  ]) {
    assert.deepEqual(
      backend.normalizePermissionRequest(native('codex', 'Bash', input)),
      {
        ok: false,
        diagnostic: 'secret-bearing-argument',
        requiresUser: true,
      },
    );
  }
});

test('schema-invalid native values fail closed without throwing', () => {
  const backend = new ClaudeCodeBackend();
  assert.deepEqual(
    backend.normalizePermissionRequest(native('claude-code', 'Bash', {
      executable: 'npm',
      argv: ['test'],
      timeoutMs: 1,
    })),
    {
      ok: false,
      diagnostic: 'invalid-native-request',
      requiresUser: true,
    },
  );
});

test('incomplete, mismatched, and unknown requests fail closed', () => {
  const backend = new KimiBackend();
  assert.equal(backend.normalizePermissionRequest({
    ...native('kimi', 'Read', {}),
    nativeRequestId: '',
  }).ok, false);
  assert.deepEqual(
    backend.normalizePermissionRequest(native('codex', 'Read', {})),
    { ok: false, diagnostic: 'backend-mismatch', requiresUser: true },
  );
  assert.deepEqual(
    backend.normalizePermissionRequest(native('kimi', 'UnrecognizedNativeTool', {})),
    { ok: false, diagnostic: 'unsupported-native-tool', requiresUser: true },
  );
});

test('canonical request schema is strict', () => {
  const backend = new ClaudeCodeBackend();
  const result = backend.normalizePermissionRequest(native('claude-code', 'Read', {}));
  assert.equal(result.ok, true);
  assert.equal(canonicalExecutionRequestSchema.safeParse({
    ...result.request,
    rawPayload: { secret: true },
  }).success, false);
});

test('Qoder and custom backends stay unavailable instead of inventing normalizers', () => {
  const qoder = new QoderBackend();
  const custom = new CustomBackend({
    id: 'custom-local',
    displayName: 'Custom',
    binaryName: 'custom',
  });
  assert.equal(qoder.capabilities.executeTasks, false);
  assert.equal(qoder.normalizePermissionRequest, undefined);
  assert.equal(custom.capabilities.executeTasks, false);
  assert.equal(custom.normalizePermissionRequest, undefined);
});
