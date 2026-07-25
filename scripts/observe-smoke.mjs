// observe-smoke.mjs — prove the observation layer against the REAL machine.
//
// Runs ObserveService (from dist-electron — run `npm run build:electron`
// first) for a few cycles against the live ~/.claude, ~/.codex and process
// table, then prints a redacted JSON summary. Read-only: the service only
// ever opens files O_RDONLY and shells out to ps/lsof.
//
// Self-exclusion is demonstrated with this script's own pid injected; no
// app-spawned workers are running, so nothing is expected to be excluded.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const servicePath = join(here, '..', 'dist-electron', 'observe', 'observe-service.js');
if (!existsSync(servicePath)) {
  console.error('dist-electron/observe/observe-service.js missing — run `npm run build:electron` first');
  process.exit(1);
}
const { ObserveService } = await import(servicePath);

const snapshots = [];
const service = new ObserveService({
  homeDir: homedir(),
  publish: (snapshot) => snapshots.push(snapshot),
  // Demonstrate the self-exclusion channel: this script's own pid plus an
  // empty session-id set (no app-spawned workers exist in this context).
  getSelfExclusion: () => ({ pids: new Set([process.pid]), sessionIds: new Set() }),
  fastMs: 400,
  slowMs: 800,
});

const CYCLES = 3;
for (let i = 0; i < CYCLES; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await service.tickOnce();
}
service.stop();

const latest = snapshots[snapshots.length - 1];
const counts = {};
for (const session of latest.sessions) {
  counts[session.clientKind] = (counts[session.clientKind] ?? 0) + 1;
}

const summary = {
  cycles: snapshots.length,
  scannedAt: new Date(latest.scannedAt).toISOString(),
  clientCounts: counts,
  sessions: latest.sessions.map((session) => ({
    clientKind: session.clientKind,
    projectName: session.projectName,
    title: session.title,
    titleSource: session.titleSource,
    state: session.state,
    activity: session.activity,
    model: session.model ?? null,
    pid: session.pid ?? null,
    isNoise: session.isNoise,
    lastActiveAt: new Date(session.lastActiveAt).toISOString(),
    evidence: session.evidence,
  })),
};

console.log(JSON.stringify(summary, null, 2));
