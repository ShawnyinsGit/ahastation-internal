#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'linux' || process.arch !== 'arm64') {
  throw new Error('whisper ARM64 self-build must run on Linux arm64');
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = join(root, 'build', 'whisper.cpp-src');
const build = join(source, 'build');
const output = join(root, 'build', 'whisper');
const cli = join(output, 'whisper-cli');
const server = join(output, 'whisper-server');

if (existsSync(cli) && existsSync(server)) {
  process.stdout.write('[build-whisper-arm64] binaries already present\n');
  process.exit(0);
}

mkdirSync(join(root, 'build'), { recursive: true });
if (!existsSync(source)) {
  run('git', [
    'clone',
    '--depth', '1',
    '--branch', 'v1.9.1',
    'https://github.com/ggerganov/whisper.cpp.git',
    source,
  ]);
}

run('cmake', [
  '-S', source,
  '-B', build,
  '-DCMAKE_BUILD_TYPE=Release',
  '-DGGML_NATIVE=ON',
  '-DBUILD_SHARED_LIBS=OFF',
]);
run('cmake', [
  '--build', build,
  '--config', 'Release',
  '--parallel',
  '--target', 'whisper-cli', 'whisper-server',
]);

mkdirSync(output, { recursive: true });
copyBinary(join(build, 'bin', 'whisper-cli'), cli);
copyBinary(join(build, 'bin', 'whisper-server'), server);

for (const binary of [cli, server]) {
  const linked = execFileSync('ldd', [binary], { encoding: 'utf8' });
  if (/\b(?:libwhisper|libggml)[^ ]*\.so\b/.test(linked)) {
    throw new Error(`${binary} still depends on an unpackaged whisper/ggml shared library:\n${linked}`);
  }
}

process.stdout.write('[build-whisper-arm64] PASS static whisper-cli + whisper-server\n');

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

function copyBinary(from, to) {
  if (!existsSync(from)) throw new Error(`whisper build output missing: ${from}`);
  copyFileSync(from, to);
  chmodSync(to, 0o755);
}
