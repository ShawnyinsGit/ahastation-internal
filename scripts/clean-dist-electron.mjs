// Remove the tsc output dir before rebuilding so deleted/renamed electron
// sources cannot leave stale .js files behind — electron-builder packages
// "dist-electron/**/*" wholesale, so stale output would ship in releases
// (e.g. the old cloud-asr/whisper modules lingered after the xfyun switch).
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await rm(join(here, '..', 'dist-electron'), { recursive: true, force: true });
