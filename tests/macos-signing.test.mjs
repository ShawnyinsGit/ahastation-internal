import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMacSignature } from '../scripts/verify-macos-signing.mjs';

test('release verifier accepts a Developer ID signature with audio-input access', () => {
  assert.doesNotThrow(() => validateMacSignature(
    'Identifier=com.ahastation.app\nAuthority=Developer ID Application: AhaStation Inc. (ABCDE12345)\nTeamIdentifier=ABCDE12345\nSignature size=9000',
    '<key>com.apple.security.device.audio-input</key><true/>',
  ));
});

test('release verifier rejects ad-hoc signatures and missing microphone entitlement', () => {
  assert.throws(
    () => validateMacSignature('Identifier=Electron\nTeamIdentifier=not set\nSignature=adhoc', ''),
    /Developer ID TeamIdentifier/,
  );
  assert.throws(
    () => validateMacSignature('TeamIdentifier=ABCDE12345', '<plist/>'),
    /Developer ID Application/,
  );
  assert.throws(
    () => validateMacSignature(
      'Authority=Apple Development: Developer (ABCDE12345)\nTeamIdentifier=ABCDE12345',
      '<key>com.apple.security.device.audio-input</key><true/>',
    ),
    /Developer ID Application/,
  );
  assert.throws(
    () => validateMacSignature(
      'Authority=Developer ID Application: AhaStation Inc. (ABCDE12345)\nTeamIdentifier=ABCDE12345',
      '<plist/>',
    ),
    /audio-input entitlement/,
  );
});
