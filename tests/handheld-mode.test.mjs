import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HANDHELD_AUTO_MAX_SCREEN_WIDTH,
  resolveUiMode,
} from '../dist-electron/handheld-mode.js';

// ---------------------------------------------------------------------------
// resolveUiMode — three-way override + auto heuristic (§3.3)
// ---------------------------------------------------------------------------

test('explicit overrides always win, regardless of signals', () => {
  assert.equal(resolveUiMode('handheld', false, 1920), 'handheld');
  assert.equal(resolveUiMode('handheld', false, 4000), 'handheld');
  assert.equal(resolveUiMode('desktop', true, 700), 'desktop');
  assert.equal(resolveUiMode('desktop', true, 1280), 'desktop');
});

test('auto: coarse pointer + narrow screen → handheld', () => {
  assert.equal(resolveUiMode('auto', true, 700), 'handheld');
  assert.equal(resolveUiMode('auto', true, 1280), 'handheld'); // Steam Deck
  assert.equal(resolveUiMode('auto', true, 1300), 'handheld'); // boundary inclusive
});

test('auto: fine pointer or wide screen → desktop', () => {
  assert.equal(resolveUiMode('auto', false, 700), 'desktop');  // narrow but mouse
  assert.equal(resolveUiMode('auto', true, 1301), 'desktop');  // just over boundary
  assert.equal(resolveUiMode('auto', true, 1920), 'desktop');
  assert.equal(resolveUiMode('auto', false, 1920), 'desktop');
});

test('boundary constant is 1300', () => {
  assert.equal(HANDHELD_AUTO_MAX_SCREEN_WIDTH, 1300);
});
