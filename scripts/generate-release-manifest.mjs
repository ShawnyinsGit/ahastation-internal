#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const dirIndex = args.indexOf('--dir');
const root = resolve(dirIndex >= 0 ? args[dirIndex + 1] : 'release');
const requireSignature = args.includes('--require-signature');
const artifacts = walk(root)
  .filter((path) => /\.(?:deb|AppImage|dmg|exe)$/i.test(path))
  .sort();
if (artifacts.length === 0) throw new Error(`No release artifacts found under ${root}`);

const lines = [];
for (const artifact of artifacts) {
  const manifestPath = relative(root, artifact).replaceAll('\\', '/');
  lines.push(`${await sha256(artifact)}  ${manifestPath}`);
}
const manifest = join(root, 'SHA256SUMS');
writeFileSync(manifest, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
process.stdout.write(`[release-manifest] wrote ${manifest} (${artifacts.length} artifacts)\n`);

const keyId = process.env.AHASTATION_RELEASE_GPG_KEY_ID?.trim();
if (keyId) {
  const result = spawnSync('gpg', [
    '--batch',
    '--yes',
    '--local-user',
    keyId,
    '--armor',
    '--detach-sign',
    '--output',
    `${manifest}.asc`,
    manifest,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`gpg signing failed with exit ${result.status}`);
  process.stdout.write(`[release-manifest] signed with ${keyId}\n`);
} else if (requireSignature) {
  throw new Error('AHASTATION_RELEASE_GPG_KEY_ID is required for a signed release');
} else {
  process.stdout.write('[release-manifest] unsigned development manifest (release gate requires a GPG key)\n');
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function walk(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}
