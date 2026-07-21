import assert from 'node:assert/strict';
import test from 'node:test';

import { editorWindowKey } from '../dist-electron/opencode-window-manager.js';

// Regression pin for the old backendId:sessionId composite key: two OpenCode
// participants in the same meeting share backendId AND the meeting-tab
// sessionId, so the second editor window could never open. The key is now
// hostId alone.
test('editor window key is unique per hostId even for the same backend', () => {
  const backendId = 'opencode';
  const sessionId = 'meeting-tab-1'; // same meeting tab for both participants

  const hostA = { hostId: 'worker-a', backendId, sessionId };
  const hostB = { hostId: 'worker-b', backendId, sessionId };

  assert.notEqual(editorWindowKey(hostA.hostId), editorWindowKey(hostB.hostId));
});

test('editor window key is stable for the same hostId', () => {
  assert.equal(editorWindowKey('worker-a'), editorWindowKey('worker-a'));
});
