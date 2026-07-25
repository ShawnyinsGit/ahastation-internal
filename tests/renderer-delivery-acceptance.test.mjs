import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  canHostAcceptDelivery,
  hostAcceptancePrimaryLabel,
  hostAcceptanceReason,
} from '../src/lib/delivery-acceptance.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('host Accept is explained for report-only and freeze-deferred deliveries', () => {
  assert.match(
    hostAcceptanceReason({
      status: 'awaiting-delivery-acceptance',
      view: { candidate: { reportOnly: true } },
      report: { files: [] },
    }) ?? '',
    /纯报告/,
  );
  assert.match(
    hostAcceptanceReason({
      status: 'awaiting-delivery-acceptance',
      error: 'candidate freeze deferred: dirty tree',
      view: { candidate: { freezeDeferred: true } },
      report: { files: [{ path: 'a.ts' }] },
    }) ?? '',
    /冻结未成功|不能靠点确认|返工/,
  );
  assert.equal(hostAcceptanceReason({ status: 'coordinator-reviewing' }), null);
});

test('freeze-deferred deliveries cannot be host-accepted', () => {
  assert.equal(canHostAcceptDelivery({
    status: 'awaiting-delivery-acceptance',
    view: { candidate: { freezeDeferred: true } },
    report: { files: [{ path: 'a.ts' }] },
  }), false);
  assert.equal(canHostAcceptDelivery({
    status: 'awaiting-delivery-acceptance',
    view: { candidate: { reportOnly: true } },
    report: { files: [] },
  }), true);
  assert.equal(hostAcceptancePrimaryLabel({
    status: 'awaiting-delivery-acceptance',
    view: { candidate: { freezeDeferred: true } },
  }), '无法确认 · 请返工');
});

test('primary Accept label distinguishes report confirmation from code accept', () => {
  assert.equal(hostAcceptancePrimaryLabel({
    status: 'awaiting-delivery-acceptance',
    view: { candidate: { reportOnly: true } },
    report: { files: [] },
  }), '确认报告');
  assert.equal(hostAcceptancePrimaryLabel({
    status: 'awaiting-delivery-acceptance',
    report: { files: [{ path: 'a.ts' }] },
  }), '通过 · 确认');
});

test('DeliveryViewer surfaces the host-acceptance reason and Meeting-branch copy', () => {
  const viewer = read('src/components/DeliveryViewer.tsx');
  assert.match(viewer, /hostAcceptanceReason/);
  assert.match(viewer, /canHostAcceptDelivery/);
  assert.match(viewer, /已进 Meeting 分支/);
  assert.match(viewer, /接受最终交付/);
});

test('accepted status labels mean Meeting branch, not user workspace publish', () => {
  const columns = read('src/lib/task-columns.ts');
  assert.match(columns, /accepted: '已进 Meeting 分支'/);
  assert.doesNotMatch(columns, /accepted: '已接受'/);
});
