import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('browser visual fixture is explicit and development-only', () => {
  const source = readFileSync(new URL('../src/dev-fixture-bootstrap.ts', import.meta.url), 'utf8');
  assert.match(source, /import\.meta\.env\.DEV/);
  assert.match(source, /get\('ui-fixture'\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
});
