// Cross-platform dev launcher. The previous npm script used POSIX inline
// env syntax (`VITE_DEV_SERVER_URL=... tsc && electron .`) which fails on
// Windows shells, and it never copied the preload .cjs files into
// dist-electron, so a fresh checkout could launch without a preload.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173',
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [join(root, 'scripts', 'clean-dist-electron.mjs')]);
run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.electron.json']);
run(process.execPath, [join(root, 'scripts', 'copy-preloads.mjs')]);

// require('electron') resolves to the platform binary path.
const electronPath = createRequire(import.meta.url)('electron');
run(electronPath, ['.']);
