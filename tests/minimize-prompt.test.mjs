// minimize-prompt.test.mjs — covers the pure minimize/close → AhaBar decision
// logic (dist-electron/minimize-prompt.js) and persistence of the 不再提示
// opt-out flag through dist-electron/store.js.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveMinimizeOutcome,
  shouldPromptMinimize,
} from '../dist-electron/minimize-prompt.js';

test('shouldPromptMinimize: prompts only when no bar, no opt-out, not quitting', () => {
  assert.equal(
    shouldPromptMinimize({ ahaBarOpen: false, promptDisabled: false, quitting: false }),
    true,
  );
  assert.equal(
    shouldPromptMinimize({ ahaBarOpen: true, promptDisabled: false, quitting: false }),
    false,
  );
  assert.equal(
    shouldPromptMinimize({ ahaBarOpen: false, promptDisabled: true, quitting: false }),
    false,
  );
  assert.equal(
    shouldPromptMinimize({ ahaBarOpen: false, promptDisabled: false, quitting: true }),
    false,
  );
});

test('resolveMinimizeOutcome: ahabar floats the bar, then minimizes or hides', () => {
  assert.equal(
    resolveMinimizeOutcome('minimize', { action: 'ahabar', never: false }),
    'open-ahabar-minimize',
  );
  assert.equal(
    resolveMinimizeOutcome('close', { action: 'ahabar', never: false }),
    'open-ahabar-hide',
  );
});

test('resolveMinimizeOutcome: hide replays the original window action', () => {
  assert.equal(
    resolveMinimizeOutcome('minimize', { action: 'hide', never: true }),
    'minimize',
  );
  assert.equal(
    resolveMinimizeOutcome('close', { action: 'hide', never: false }),
    'close',
  );
});

test('store: ahaBarPromptDisabled flag round-trips through settings', async (t) => {
  const { getSettings, updateSettings } = await import('../dist-electron/store.js');
  const original = getSettings().ahaBarPromptDisabled;
  t.after(async () => {
    await updateSettings({ ahaBarPromptDisabled: original });
  });
  await updateSettings({ ahaBarPromptDisabled: true });
  assert.equal(getSettings().ahaBarPromptDisabled, true);
});
