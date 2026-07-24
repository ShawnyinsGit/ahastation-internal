import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeBackendBaseUrl } from '../dist-electron/normalize-base-url.js';

test('normalizeBackendBaseUrl trims whitespace and trailing slashes', () => {
  assert.equal(normalizeBackendBaseUrl(undefined), undefined);
  assert.equal(normalizeBackendBaseUrl(''), undefined);
  assert.equal(normalizeBackendBaseUrl('   '), undefined);
  assert.equal(normalizeBackendBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.equal(normalizeBackendBaseUrl('  https://gateway.example/v1///  '), 'https://gateway.example/v1');
});

test('setBackendAuth persists a normalized Codex base URL', async (t) => {
  const { setBackendAuth, getBackendAuth, removeBackendAuth } = await import('../dist-electron/store.js');
  await setBackendAuth('codex', { baseUrl: 'https://api.example.com/v1/' });
  t.after(async () => { await removeBackendAuth('codex'); });
  assert.equal(getBackendAuth('codex')?.baseUrl, 'https://api.example.com/v1');
});
