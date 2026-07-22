import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveCustomProviderConfig } from '../dist-electron/backends/opencode-server-process.js';
import { OpenCodeBackend } from '../dist-electron/backends/opencode-adapter.js';

// ---------------------------------------------------------------------------
// deriveCustomProviderConfig: non-built-in providers need a config
// declaration or opencode stalls the turn on ProviderModelNotFoundError.
// ---------------------------------------------------------------------------

test('kimi key+baseUrl+model hint → custom provider declaration', () => {
  const out = deriveCustomProviderConfig({
    KIMI_API_KEY: 'sk-test',
    KIMI_BASE_URL: 'https://api.kimi.com/coding/v1',
    AHAMEET_OPENCODE_MODEL: 'kimi/k3',
  });
  assert.deepEqual(out, {
    provider: {
      kimi: {
        npm: '@ai-sdk/openai-compatible',
        name: 'kimi',
        options: { baseURL: 'https://api.kimi.com/coding/v1', apiKey: '{env:KIMI_API_KEY}' },
        models: { k3: { name: 'k3' } },
      },
    },
  });
});

test('built-in providers never get a custom declaration', () => {
  const out = deriveCustomProviderConfig({
    OPENAI_API_KEY: 'sk-test',
    OPENAI_BASE_URL: 'https://api.kimi.com/coding/v1',
    AHAMEET_OPENCODE_MODEL: 'openai/k3',
  });
  assert.deepEqual(out, {});
});

test('missing baseUrl or model hint → no declaration (fail-closed)', () => {
  assert.deepEqual(deriveCustomProviderConfig({ KIMI_API_KEY: 'sk-test' }), {});
  assert.deepEqual(
    deriveCustomProviderConfig({
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'https://api.kimi.com/coding/v1',
    }),
    {},
  );
  assert.deepEqual(deriveCustomProviderConfig(undefined), {});
});

test('model provider mismatch with the key prefix → no declaration', () => {
  const out = deriveCustomProviderConfig({
    KIMI_API_KEY: 'sk-test',
    KIMI_BASE_URL: 'https://api.kimi.com/coding/v1',
    AHAMEET_OPENCODE_MODEL: 'anthropic/claude-sonnet-4-5',
  });
  assert.deepEqual(out, {});
});

test('buildEnv passes the model hint through for non-built-in providers', () => {
  const backend = new OpenCodeBackend();
  const env = backend.buildEnv({
    authMode: 'apikey',
    apiKey: 'sk-test',
    model: 'kimi/k3',
    baseUrl: 'https://api.kimi.com/coding/v1',
  });
  assert.equal(env.KIMI_API_KEY, 'sk-test');
  assert.equal(env.KIMI_BASE_URL, 'https://api.kimi.com/coding/v1');
  assert.equal(env.AHAMEET_OPENCODE_MODEL, 'kimi/k3');
});
