import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  editorWindowSenderPolicy,
  emptyPayloadSchema,
  mainWindowSenderPolicy,
  parsePayload,
} from '../dist-electron/ipc/validators.js';

// ---------------------------------------------------------------------------
// parsePayload — the strict schema gate every handleSecure channel applies
// ---------------------------------------------------------------------------

const strictSchema = z.object({ path: z.string().min(1) }).strict();

test('parsePayload accepts a valid payload and returns its data', () => {
  const result = parsePayload(strictSchema, { path: 'a.txt' });
  assert.deepEqual(result, { ok: true, data: { path: 'a.txt' } });
});

test('parsePayload rejects non-object payloads', () => {
  for (const raw of [42, 'x', true, null, undefined]) {
    const result = parsePayload(strictSchema, raw);
    assert.equal(result.ok, false, `expected rejection for ${String(raw)}`);
    assert.equal(typeof result.error, 'string');
  }
});

test('parsePayload rejects smuggled extra keys and missing keys', () => {
  assert.equal(parsePayload(strictSchema, { path: 'a', cwd: '/' }).ok, false);
  assert.equal(parsePayload(strictSchema, {}).ok, false);
  assert.equal(parsePayload(strictSchema, { path: 1 }).ok, false);
});

test('emptyPayloadSchema accepts no-payload calls but nothing else', () => {
  assert.equal(parsePayload(emptyPayloadSchema, undefined).ok, true);
  assert.equal(parsePayload(emptyPayloadSchema, null).ok, true);
  assert.equal(parsePayload(emptyPayloadSchema, {}).ok, true);
  assert.equal(parsePayload(emptyPayloadSchema, { hostId: 'x' }).ok, false);
  assert.equal(parsePayload(emptyPayloadSchema, 0).ok, false);
});

// ---------------------------------------------------------------------------
// mainWindowSenderPolicy — only the main window's webContents id passes
// ---------------------------------------------------------------------------

test('mainWindowSenderPolicy passes the main window id and rejects others', () => {
  const policy = mainWindowSenderPolicy(() => 7);
  assert.equal(policy(7), true);
  assert.equal(policy(8), false);
});

test('mainWindowSenderPolicy rejects everything when no main window lives', () => {
  const policy = mainWindowSenderPolicy(() => null);
  assert.equal(policy(7), false);
});

// ---------------------------------------------------------------------------
// editorWindowSenderPolicy — only registered editor window ids pass
// ---------------------------------------------------------------------------

test('editorWindowSenderPolicy passes registered ids and rejects unknown ones', () => {
  const policy = editorWindowSenderPolicy((id) => id === 42);
  assert.equal(policy(42), true);
  assert.equal(policy(1), false);
});

test('editorWindowSenderPolicy default lookup rejects unregistered ids', () => {
  // No editor windows exist in the test process, so the real registry must
  // reject any sender id — the same fail-closed answer an arbitrary renderer
  // (main window, popout, settings) gets when calling ide-files:*.
  const policy = editorWindowSenderPolicy();
  assert.equal(policy(1), false);
  assert.equal(policy(99999), false);
});
