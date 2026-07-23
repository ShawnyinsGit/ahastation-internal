import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveCodexRuntime } from '../dist-electron/backends/codex-adapter.js';

test('resolveCodexRuntime prefers an executable unpacked native binary', async (t) => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    t.skip('fixture currently targets the macOS ARM64 release build');
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'ahastation-codex-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(
    root,
    'app.asar.unpacked/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  );
  await mkdir(join(binary, '..'), { recursive: true });
  await writeFile(binary, '#!/bin/sh\nexit 0\n');
  await chmod(binary, 0o755);

  assert.equal(resolveCodexRuntime(root), await realpath(binary));
  assert.equal(resolveCodexRuntime(root).includes('app.asar/'), false);
});
