import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MODEL_MIN_SIZE,
  MODEL_NAME,
  MODEL_SIZE,
  whisperArchiveFor,
  whisperBinaryName,
} from '../scripts/lib/whisper-platforms.mjs';
import { chooseGgmlBackend } from '../dist-electron/whisper-ggml.js';
import {
  checkLatestRelease,
  compareVersions,
  parseLatestTag,
} from '../dist-electron/update-check.js';

// ---------------------------------------------------------------------------
// whisper platform mapping (v1.9.1 official assets, verified live 2026-07-21)
// ---------------------------------------------------------------------------

test('whisperArchiveFor maps x64 platforms to official v1.9.1 archives', () => {
  assert.equal(
    whisperArchiveFor('linux', 'x64'),
    'https://github.com/ggerganov/whisper.cpp/releases/download/v1.9.1/whisper-bin-ubuntu-x64.tar.gz',
  );
  assert.equal(
    whisperArchiveFor('win32', 'x64'),
    'https://github.com/ggerganov/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip',
  );
});

test('whisperArchiveFor returns null where no official prebuilt exists', () => {
  assert.equal(whisperArchiveFor('darwin', 'arm64'), null); // brew path
  assert.equal(whisperArchiveFor('darwin', 'x64'), null);
  assert.equal(whisperArchiveFor('linux', 'arm64'), null); // self-build
  assert.equal(whisperArchiveFor('win32', 'arm64'), null);
});

test('whisperBinaryName appends .exe only on win32; model constants sane', () => {
  assert.equal(whisperBinaryName('whisper-cli', 'win32'), 'whisper-cli.exe');
  assert.equal(whisperBinaryName('whisper-cli', 'linux'), 'whisper-cli');
  assert.equal(MODEL_NAME, 'ggml-small-q5_1.bin');
  assert.ok(MODEL_MIN_SIZE < MODEL_SIZE && MODEL_MIN_SIZE > MODEL_SIZE - 2_000_000);
});

// ---------------------------------------------------------------------------
// ggml backend selection
// ---------------------------------------------------------------------------

test('chooseGgmlBackend prefers apple_m1 on darwin, falls back to generic', () => {
  assert.equal(
    chooseGgmlBackend(['libggml-cpu-apple_m1.so', 'libggml-cpu.so'], 'darwin'),
    'libggml-cpu-apple_m1.so',
  );
  assert.equal(chooseGgmlBackend(['libggml-cpu-icelake.so'], 'darwin'), 'libggml-cpu-icelake.so');
  assert.equal(chooseGgmlBackend(['libggml-metal.so'], 'darwin'), null);
});

test('chooseGgmlBackend on linux/win prefers the generic plugin', () => {
  assert.equal(
    chooseGgmlBackend(['libggml-base.so', 'libggml-cpu.so'], 'linux'),
    'libggml-cpu.so',
  );
  assert.equal(chooseGgmlBackend(['libggml-cpu-sse42.so'], 'linux'), 'libggml-cpu-sse42.so');
  assert.equal(chooseGgmlBackend(['ggml-base.dll', 'ggml-cpu.dll'], 'win32'), 'ggml-cpu.dll');
  assert.equal(
    chooseGgmlBackend(['ggml-cpu-alderlake.dll', 'ggml-cpu-x64.dll', 'ggml-cpu-sse42.dll'], 'win32'),
    'ggml-cpu-x64.dll',
  );
  assert.equal(chooseGgmlBackend(['ggml-cpu-sse42.dll', 'ggml-cpu-haswell.dll'], 'win32'), 'ggml-cpu-sse42.dll');
  assert.equal(chooseGgmlBackend([], 'linux'), null);
  assert.equal(chooseGgmlBackend(['random.txt'], 'win32'), null);
});

// ---------------------------------------------------------------------------
// version comparison + release tag parsing + probe behavior
// ---------------------------------------------------------------------------

test('compareVersions orders numeric triples with optional v prefix', () => {
  assert.equal(compareVersions('1.9.1', '1.9.1'), 0);
  assert.ok(compareVersions('v1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('0.16.3', 'v0.17.0') < 0);
  assert.ok(compareVersions('1.2', '1.2.1') < 0);
  assert.ok(compareVersions('1.2.0', '1.2') > 0 || compareVersions('1.2.0', '1.2') === 0);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('parseLatestTag extracts tags from redirect locations', () => {
  assert.equal(
    parseLatestTag('https://github.com/ShawnyinsGit/AhaStation/releases/tag/v0.17.0'),
    'v0.17.0',
  );
  assert.equal(parseLatestTag('/ShawnyinsGit/AhaStation/releases/tag/v1.2.0-beta'), 'v1.2.0-beta');
  assert.equal(parseLatestTag(null), null);
  assert.equal(parseLatestTag('https://github.com/other/page'), null);
});

function fakeFetch(status, location = null) {
  return async () => ({ status, headers: { get: () => location } });
}

test('checkLatestRelease reports newer tags and ignores older/equal ones', async () => {
  const newer = await checkLatestRelease('0.16.3', fakeFetch(302, '/x/releases/tag/v0.17.0'));
  assert.deepEqual(newer, {
    available: true,
    latest: 'v0.17.0',
    url: 'https://github.com/ShawnyinsGit/AhaStation/releases',
  });
  const same = await checkLatestRelease('0.17.0', fakeFetch(302, '/x/releases/tag/v0.17.0'));
  assert.equal(same.available, false);
});

test('checkLatestRelease silently no-ops on private-repo 404 and network errors', async () => {
  assert.deepEqual(await checkLatestRelease('0.16.3', fakeFetch(404)), { available: false });
  assert.deepEqual(await checkLatestRelease('0.16.3', fakeFetch(200)), { available: false });
  const throwing = async () => { throw new Error('offline'); };
  assert.deepEqual(await checkLatestRelease('0.16.3', throwing), { available: false });
});
