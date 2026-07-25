import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessWorkerRuntime,
  assessConfiguredWorkerRuntime,
  extractRuntimeVersion,
  resolveWorkerExpectedVersion,
} from '../dist-electron/backends/worker-runtime-contract.js';

test('runtime versions are extracted from common CLI output', () => {
  assert.equal(extractRuntimeVersion('codex-cli 0.144.1'), '0.144.1');
  assert.equal(extractRuntimeVersion('Claude Code v2.1.150 (stable)'), '2.1.150');
  assert.equal(extractRuntimeVersion('unknown'), null);
});

test('Worker runtime gate fails closed for missing, incompatible and unauthenticated runtimes', () => {
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: false, implementationEnabled: true,
    authenticated: false, version: null,
  }).state, 'needs-install');
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: true, implementationEnabled: true,
    authenticated: true, version: '0.145.0',
  }).state, 'version-incompatible');
  assert.equal(assessWorkerRuntime({
    backendId: 'codex', installed: true, implementationEnabled: true,
    authenticated: false, version: '0.144.1',
  }).state, 'needs-login');
});

test('Worker runtime becomes available only at the tested version with authentication', () => {
  for (const [backendId, version] of [
    ['claude-code', '2.1.150'],
    ['opencode', '1.18.3'],
    ['codex', '0.144.1'],
    ['kimi', '0.24.1'],
  ]) {
    const result = assessWorkerRuntime({
      backendId,
      installed: true,
      implementationEnabled: true,
      authenticated: true,
      version,
    });
    assert.equal(result.state, 'available', backendId);
    assert.equal(result.expectedVersion, version, backendId);
  }
});

test('system Claude Code CLI accepts the probed version instead of the bundled pin', () => {
  assert.equal(
    resolveWorkerExpectedVersion('claude-code', '2.1.215', { claudeCodeCliSource: 'system' }),
    '2.1.215',
  );
  assert.equal(
    resolveWorkerExpectedVersion('claude-code', '2.1.215', { claudeCodeCliSource: 'bundled' }),
    '2.1.150',
  );
  const result = assessWorkerRuntime({
    backendId: 'claude-code',
    installed: true,
    implementationEnabled: true,
    authenticated: true,
    version: '2.1.215',
    expectedVersionOverride: '2.1.215',
  });
  assert.equal(result.state, 'available');
  assert.equal(result.expectedVersion, '2.1.215');
});

test('assessConfiguredWorkerRuntime accepts system Claude versions at dispatch time', () => {
  const result = assessConfiguredWorkerRuntime({
    backendId: 'claude-code',
    installed: true,
    implementationEnabled: true,
    authenticated: true,
    version: '2.1.215',
    claudeCodeCliSource: 'system',
  });
  assert.equal(result.state, 'available');
  assert.equal(result.expectedVersion, '2.1.215');
});
