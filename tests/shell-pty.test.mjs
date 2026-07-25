import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDefaultShell } from '../dist-electron/pty-host.js';

test('resolveDefaultShell returns a non-empty shell path', () => {
  const shell = resolveDefaultShell();
  assert.equal(typeof shell, 'string');
  assert.ok(shell.length > 0, `expected a non-empty shell path, got: ${shell}`);
});

test('resolveDefaultShell picks a platform-appropriate default', () => {
  const shell = resolveDefaultShell();
  if (process.platform === 'win32') {
    // pwsh / powershell full path, or cmd.exe / %COMSPEC% fallback.
    const lower = shell.toLowerCase();
    assert.ok(
      lower.endsWith('pwsh.exe') ||
        lower.endsWith('powershell.exe') ||
        lower.endsWith('cmd.exe'),
      `unexpected windows shell: ${shell}`,
    );
  } else {
    // $SHELL or /bin/bash - must look like an absolute path.
    assert.ok(shell.startsWith('/'), `expected an absolute shell path, got: ${shell}`);
  }
});
