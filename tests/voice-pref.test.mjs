import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVoicePrefUpdate } from '../dist-electron/ipc/settings.js';

// buildVoicePrefUpdate is the pure validation gate behind
// settings:set-voice-pref. Historically an unknown enum value (or a boolean
// passed where an enum belongs) was silently dropped; it must now fail
// loudly so renderer bugs surface instead of vanishing.

test('accepts a full valid patch and maps renderer keys to settings keys', () => {
  const r = buildVoicePrefUpdate({
    selectedVoiceName: 'Tingting',
    guidanceDismissed: true,
    speechFilterMode: 'off',
    voicePolishEnabled: true,
    reportModeEnabled: false,
    handheldMode: 'handheld',
    asrProvider: 'cloud',
    cloudAsr: { baseUrl: ' https://api.groq.com/openai/v1 ', apiKey: ' gsk ', model: ' whisper-large-v3 ' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, {
    selectedVoiceName: 'Tingting',
    voiceGuidanceDismissed: true,
    speechFilterMode: 'off',
    voicePolishEnabled: true,
    reportModeEnabled: false,
    handheldMode: 'handheld',
    asrProvider: 'cloud',
    cloudAsr: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk', model: 'whisper-large-v3' },
  });
});

test('selectedVoiceName accepts an explicit null clear', () => {
  const r = buildVoicePrefUpdate({ selectedVoiceName: null });
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, { selectedVoiceName: null });
});

test('rejects invalid enum values instead of silently ignoring them', () => {
  for (const patch of [
    { speechFilterMode: 'loud' },
    { handheldMode: 'tablet' },
    { asrProvider: 'remote' },
    // The reported footgun: a boolean where an enum belongs.
    { asrProvider: true },
    { speechFilterMode: true },
  ]) {
    const r = buildVoicePrefUpdate(patch);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(patch)}`);
    assert.equal(typeof r.error, 'string');
  }
});

test('rejects wrong-typed boolean fields', () => {
  for (const patch of [
    { guidanceDismissed: 'yes' },
    { voicePolishEnabled: 1 },
    { reportModeEnabled: null },
  ]) {
    assert.equal(buildVoicePrefUpdate(patch).ok, false, `expected rejection for ${JSON.stringify(patch)}`);
  }
});

test('rejects malformed cloudAsr payloads', () => {
  assert.equal(buildVoicePrefUpdate({ cloudAsr: 'https://x' }).ok, false);
  assert.equal(buildVoicePrefUpdate({ cloudAsr: { apiKey: 42 } }).ok, false);
  assert.equal(buildVoicePrefUpdate({ cloudAsr: { baseUrl: null } }).ok, false);
});

test('rejects a non-object patch', () => {
  for (const patch of [null, 42, 'x']) {
    assert.equal(buildVoicePrefUpdate(patch).ok, false);
  }
});

test('omitted keys produce no settings writes', () => {
  const r = buildVoicePrefUpdate({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.next, {});
});
