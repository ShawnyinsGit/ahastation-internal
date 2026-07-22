import assert from 'node:assert/strict';
import test from 'node:test';

import { planSessionResume } from '../dist-electron/backends/opencode-events.js';
import {
  findStaleRecords,
  STALE_RECORD_MAX_AGE_MS,
} from '../dist-electron/ide/opencode/opencode-server-registry.js';

// ---------------------------------------------------------------------------
// planSessionResume — snapshot id × server-side session list
// ---------------------------------------------------------------------------

test('no snapshot sessionId → fresh session', () => {
  assert.deepEqual(planSessionResume(null, ['ses_1']), { kind: 'fresh' });
  assert.deepEqual(planSessionResume(undefined, []), { kind: 'fresh' });
  assert.deepEqual(planSessionResume('', ['ses_1']), { kind: 'fresh' });
});

test('snapshot id still present server-side → resume it', () => {
  assert.deepEqual(
    planSessionResume('ses_old', ['ses_1', 'ses_old', 'ses_2']),
    { kind: 'resume', sessionId: 'ses_old' },
  );
});

test('snapshot id gone server-side → expired (degrade with visible notice)', () => {
  assert.deepEqual(planSessionResume('ses_gone', ['ses_1']), { kind: 'expired' });
  assert.deepEqual(planSessionResume('ses_gone', []), { kind: 'expired' });
});

// ---------------------------------------------------------------------------
// findStaleRecords — GC hint for ancient orphan records
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000_000;
const rec = (cwd, startedAt) => ({
  meetingId: 'm', cwd, pid: 1, url: 'http://x', password: 'p', startedAt,
});

test('findStaleRecords picks only records older than the max age', () => {
  const records = [
    rec('/fresh', NOW - 1000),
    rec('/old', NOW - STALE_RECORD_MAX_AGE_MS - 1000),
    rec('/boundary-ok', NOW - STALE_RECORD_MAX_AGE_MS),
  ];
  const stale = findStaleRecords(records, NOW);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].cwd, '/old');
  assert.equal(findStaleRecords([], NOW).length, 0);
});
