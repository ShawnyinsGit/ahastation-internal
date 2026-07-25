import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMeetingPlanBrief } from '../dist-electron/meeting-tools.js';

test('normalizeMeetingPlanBrief keeps a full Cursor-style plan document', () => {
  const brief = normalizeMeetingPlanBrief({
    goal: 'Ship auth refresh without downtime',
    approach: 'Split read-path probe from write-path rollout',
    steps: [
      { title: 'Probe current tokens', detail: 'Read session store shapes', taskId: 'probe' },
      { title: 'Roll out refresh', detail: 'Write new issuer', taskId: 'rollout' },
    ],
    risks: ['Legacy clients may reject new claims'],
    openQuestions: ['Do we keep old tokens for 24h?'],
  }, [
    { id: 'probe', title: 'Probe', prompt: 'inspect tokens' },
    { id: 'rollout', title: 'Rollout', prompt: 'ship issuer' },
  ]);

  assert.equal(brief.goal, 'Ship auth refresh without downtime');
  assert.match(brief.approach ?? '', /Split read-path/);
  assert.equal(brief.steps.length, 2);
  assert.equal(brief.steps[0].taskId, 'probe');
  assert.deepEqual(brief.risks, ['Legacy clients may reject new claims']);
  assert.deepEqual(brief.openQuestions, ['Do we keep old tokens for 24h?']);
});

test('normalizeMeetingPlanBrief synthesizes steps from bare tasks', () => {
  const brief = normalizeMeetingPlanBrief(undefined, [
    { id: 'a', title: 'Explore API', prompt: 'Map endpoints and auth headers in detail.' },
    { id: 'b', title: 'Draft client', prompt: 'Implement thin client using findings.' },
  ]);
  assert.match(brief.goal, /2 项/);
  assert.equal(brief.steps.length, 2);
  assert.equal(brief.steps[0].taskId, 'a');
  assert.match(brief.steps[0].detail, /Map endpoints/);
  assert.deepEqual(brief.risks, []);
});
