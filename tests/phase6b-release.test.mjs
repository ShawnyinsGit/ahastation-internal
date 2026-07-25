import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkLatestRelease,
  compareVersions,
  parseLatestTag,
} from '../dist-electron/update-check.js';

// ---------------------------------------------------------------------------
// version comparison + release tag parsing + probe behavior
// (the whisper platform/ggml portions of this file were removed when ASR
//  switched to Xunfei streaming - only the update-probe tests remain.)
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
