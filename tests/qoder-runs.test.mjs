import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeQoderLogTail,
  listQoderRuns,
  parseQoderRun,
  parseQoderRunManifest,
} from '../dist-electron/observe/statefiles/qoder-runs.js';

async function createHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ahastation-qoder-runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeRun(home, runId, manifest, logLines = []) {
  const runDir = join(home, '.qoder', 'logs', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest));
  if (logLines.length > 0) {
    await writeFile(join(runDir, 'qodercli.log'), logLines.join('\n'));
  }
  return runDir;
}

const MANIFEST = {
  run_id: '2026-07-26T17-26-03-434+08-00-xc5dua-p61935',
  started_at: '2026-07-26T17:26:03.434+08:00',
  pid: 61935,
  ppid: 61093,
  process_role: 'main',
  cli_version: '1.0.47',
  cwd: '/Users/x/proj',
  project_id: '-Users-x-proj',
};

test('manifest parser extracts identity fields', () => {
  const parsed = parseQoderRunManifest(JSON.stringify(MANIFEST));
  assert.equal(parsed.runId, MANIFEST.run_id);
  assert.equal(parsed.pid, 61935);
  assert.equal(parsed.ppid, 61093);
  assert.equal(parsed.cwd, '/Users/x/proj');
  assert.equal(parsed.projectId, '-Users-x-proj');
  assert.equal(parsed.cliVersion, '1.0.47');
  assert.equal(parsed.processRole, 'main');
  assert.ok(parsed.startedAtMs > 0);
});

test('manifest parser is fail-open', () => {
  assert.equal(parseQoderRunManifest('not json'), null);
  assert.equal(parseQoderRunManifest('{}'), null); // no run_id
  assert.equal(parseQoderRunManifest('null'), null);
  const noPid = parseQoderRunManifest(JSON.stringify({ run_id: 'r1' }));
  assert.equal(noPid.pid, null);
  assert.equal(noPid.startedAtMs, 0);
});

test('listQoderRuns returns newest-first refs and skips non-conforming entries', async (t) => {
  const home = await createHome(t);
  await writeRun(home, '2026-07-26T10-00-00-000+08-00-aaaaaa-p1', { ...MANIFEST, run_id: 'r-old', pid: 1 });
  await writeRun(home, '2026-07-26T12-00-00-000+08-00-bbbbbb-p2', { ...MANIFEST, run_id: 'r-new', pid: 2 });
  // A stray file (not a dir) and a dir without a manifest are skipped.
  await writeFile(join(home, '.qoder', 'logs', 'runs', 'stray-file'), 'x');
  await mkdir(join(home, '.qoder', 'logs', 'runs', '2026-07-26T11-00-00-000+08-00-nomanifest'), { recursive: true });

  const refs = await listQoderRuns(home);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].runId, '2026-07-26T12-00-00-000+08-00-bbbbbb-p2');
  assert.equal(refs[1].runId, '2026-07-26T10-00-00-000+08-00-aaaaaa-p1');
});

test('listQoderRuns skips symlinked manifests (fail closed)', async (t) => {
  const home = await createHome(t);
  const runDir = await writeRun(home, '2026-07-26T12-00-00-000+08-00-bbbbbb-p2', MANIFEST);
  const outside = join(home, 'outside.json');
  await writeFile(outside, JSON.stringify(MANIFEST));
  await rm(join(runDir, 'manifest.json'));
  await symlink(outside, join(runDir, 'manifest.json'));
  const refs = await listQoderRuns(home);
  assert.equal(refs.length, 0);
});

test('listQoderRuns degrades to empty when the runs root is missing', async (t) => {
  const home = await createHome(t);
  assert.deepEqual(await listQoderRuns(home), []);
});

test('parseQoderRun reads manifest plus last log event time', async (t) => {
  const home = await createHome(t);
  await writeRun(home, '2026-07-26T12-00-00-000+08-00-bbbbbb-p2', MANIFEST, [
    '2026-07-26T12:00:01.000+08:00 INFO  process.started pid=2',
    'not a timestamped line',
    '2026-07-26T12:05:41.500+08:00 INFO  cli.main.started',
  ]);
  const refs = await listQoderRuns(home);
  assert.equal(refs.length, 1);
  const info = await parseQoderRun(refs[0]);
  assert.equal(info.runId, MANIFEST.run_id);
  assert.equal(info.pid, 61935);
  assert.equal(info.lastLogEventAtMs, Date.parse('2026-07-26T12:05:41.500+08:00'));
});

test('parseQoderRun tolerates a missing log file', async (t) => {
  const home = await createHome(t);
  await writeRun(home, '2026-07-26T12-00-00-000+08-00-bbbbbb-p2', MANIFEST);
  const refs = await listQoderRuns(home);
  const info = await parseQoderRun(refs[0]);
  assert.equal(info.lastLogEventAtMs, 0);
});

test('analyzeQoderLogTail takes the max leading ISO timestamp', () => {
  const { lastLogEventAtMs } = analyzeQoderLogTail([
    'garbage',
    '2026-07-26T10:00:00Z INFO  a',
    '2026-07-26T10:03:00Z INFO  b',
    '2026-07-26T10:01:00Z INFO  out of order',
  ]);
  assert.equal(lastLogEventAtMs, Date.parse('2026-07-26T10:03:00Z'));
  assert.equal(analyzeQoderLogTail([]).lastLogEventAtMs, 0);
  assert.equal(analyzeQoderLogTail(['no timestamps here']).lastLogEventAtMs, 0);
});
