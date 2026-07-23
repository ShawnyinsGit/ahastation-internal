import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { whisperServerEnv } from '../dist-electron/whisper-server.js';

// Fixture-driven (machine-independent): the previous version scanned the
// real /Applications/<product>.app — it only passed on machines where that
// app happened to be installed, and broke the moment productName changed.
const PLUGIN_BY_PLATFORM = {
  darwin: 'libggml-cpu-apple_m1.so',
  linux: 'libggml-cpu.so',
  win32: 'ggml-cpu.dll',
};

test('packaged Whisper loads ggml backends from its bundled resource directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whisper-pkg-'));
  writeFileSync(join(dir, 'libggml-cpu-apple_m1.so'), '');
  writeFileSync(join(dir, 'libggml-cpu.so'), '');
  writeFileSync(join(dir, 'ggml-cpu.dll'), '');
  writeFileSync(join(dir, 'ggml-small-q5_1.bin'), '');

  const expected = PLUGIN_BY_PLATFORM[process.platform];
  const env = whisperServerEnv(dir);
  if (expected) {
    assert.equal(env.GGML_BACKEND_PATH, join(dir, expected));
  } else {
    assert.equal(env.GGML_BACKEND_PATH, undefined);
  }
});
