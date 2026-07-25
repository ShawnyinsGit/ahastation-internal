import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  buildRendererSecurityHeaders,
  resolveAppAssetPath,
  themeBackgroundColor,
} from '../dist-electron/renderer-security.js';

test('packaged renderer enables local ONNX/VAD execution and cross-origin isolation', () => {
  const headers = buildRendererSecurityHeaders({ isDev: false });
  assert.match(headers['Content-Security-Policy'][0], /script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'/);
  assert.match(headers['Content-Security-Policy'][0], /worker-src 'self' blob:/);
  assert.equal(headers['Cross-Origin-Opener-Policy'][0], 'same-origin');
  assert.equal(headers['Cross-Origin-Embedder-Policy'][0], 'require-corp');
  assert.equal(headers['X-Content-Type-Options'][0], 'nosniff');
});

test('app protocol only serves files inside the renderer bundle', () => {
  const root = resolve('Applications', 'AhaStation', 'dist');
  assert.equal(
    resolveAppAssetPath(root, 'app://bundle/assets/app.js'),
    join(root, 'assets', 'app.js'),
  );
  assert.equal(resolveAppAssetPath(root, 'app://other/index.html'), null);
  assert.equal(resolveAppAssetPath(root, 'app://bundle/%2F..%2F..%2Fsecret.txt'), null);
  assert.equal(resolveAppAssetPath(root, 'app://bundle/'), join(root, 'index.html'));
});

test('development renderer scopes HMR access to the configured Vite origin', () => {
  const headers = buildRendererSecurityHeaders({
    isDev: true,
    devServerUrl: 'http://localhost:5173/path',
  });
  const csp = headers['Content-Security-Policy'][0];
  assert.match(csp, /connect-src 'self' http:\/\/localhost:5173 ws:\/\/localhost:5173/);
  assert.doesNotMatch(csp, /\/path/);
});

test('native window background follows the active system theme', () => {
  assert.equal(themeBackgroundColor(true), '#1c1c1e');
  assert.equal(themeBackgroundColor(false), '#f2f2f7');
});

test('HTML fallback CSP does not narrow away the VAD blob worker', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /worker-src 'self' blob:/);
  assert.match(html, /object-src 'none'/);
});
