import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const output = join(root, 'dist-electron');
const preloads = ['preload.cjs', 'preload-editor.cjs', 'preload-companion.cjs'];

await mkdir(output, { recursive: true });
await Promise.all(preloads.map((name) => copyFile(
  join(root, 'electron', name),
  join(output, name),
)));
