#!/usr/bin/env node
// assert-whisper-assets.mjs — CI gate (Phase 6b): fail the build when the
// package would ship without whisper assets. The fetch script used to exit 0
// on download failure, silently producing whisper-less packages; this
// assertion runs AFTER fetch/prebuild and exits 1 on any mandatory miss.

import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_MIN_SIZE, MODEL_NAME, whisperBinaryName } from './lib/whisper-platforms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'build', 'whisper');

const failures = [];
const warnings = [];

function checkFile(label, path, minBytes, { mandatory = true } = {}) {
  if (!existsSync(path)) {
    (mandatory ? failures : warnings).push(`${label} missing: ${path}`);
    return;
  }
  const size = statSync(path).size;
  if (size < minBytes) {
    (mandatory ? failures : warnings).push(`${label} too small (${size} bytes): ${path}`);
  } else {
    process.stdout.write(`[assert-whisper] ${label} ok (${(size / 1e6).toFixed(1)} MB)\n`);
  }
}

// Mandatory: whisper-cli + the model. whisper-server is an optimization
// (per-call whisper-cli fallback exists) so it only warns.
checkFile('whisper-cli', join(outDir, whisperBinaryName('whisper-cli', process.platform)), 1_000_000);
checkFile('model', join(outDir, MODEL_NAME), MODEL_MIN_SIZE);
checkFile('whisper-server', join(outDir, whisperBinaryName('whisper-server', process.platform)), 1_000_000, { mandatory: false });

for (const w of warnings) process.stdout.write(`[assert-whisper] warn: ${w}\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`[assert-whisper] FAIL: ${f}\n`);
  process.exit(1);
}
process.stdout.write('[assert-whisper] all mandatory assets present\n');
