import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateMacSignature(details, entitlements) {
  const team = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!team || team === 'not set') {
    throw new Error('macOS release must have a Developer ID TeamIdentifier');
  }
  if (!/^Authority=Developer ID Application:/m.test(details)) {
    throw new Error('macOS release must be signed with a Developer ID Application certificate');
  }
  if (!/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/.test(entitlements)) {
    throw new Error('macOS release is missing the audio-input entitlement');
  }
}

function runCodesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'codesign failed').trim());
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

export function verifyMacApp(appPath) {
  if (!existsSync(appPath)) throw new Error(`macOS app not found: ${appPath}`);
  runCodesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const details = runCodesign(['-d', '--verbose=4', appPath]);
  const entitlements = runCodesign(['-d', '--entitlements', ':-', appPath]);
  validateMacSignature(details, entitlements);
  console.log(`[mac-signing] verified Developer ID signature and microphone entitlement: ${appPath}`);
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const appPath = resolve(process.argv[2] ?? 'release/mac-arm64/AhaStation.app');
  try {
    verifyMacApp(appPath);
  } catch (error) {
    console.error(`[mac-signing] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
