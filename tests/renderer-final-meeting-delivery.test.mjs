import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('final Meeting delivery is the only renderer surface with acceptance controls', () => {
  const finalPanel = read('src/components/FinalMeetingDelivery.tsx');
  const inspector = read('src/components/TaskInspector.tsx');
  assert.match(finalPanel, /接受最终交付/);
  assert.match(finalPanel, /请求返工/);
  assert.match(finalPanel, /返工原因（必填）/);
  assert.match(finalPanel, /已进 Meeting 分支的任务和集成提交保持终态/);
  assert.match(finalPanel, /不等于发布到你的工作区/);
  assert.doesNotMatch(inspector, /接受最终交付|请求返工/);
});

test('final panel exposes integration, verification, review, approvals, and limitations', () => {
  const finalPanel = read('src/components/FinalMeetingDelivery.tsx');
  for (const label of [
    '仅在 Meeting 集成分支（未发布）',
    '已发布到主工作区',
    '任务验证与审查',
    '集成文件',
    '高风险确认',
    '未解决工作',
    '限制：',
  ]) {
    assert.match(finalPanel, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('renderer uses typed final-delivery IPC and journal-backed update events', () => {
  const preload = read('electron/preload.cjs');
  const store = read('src/lib/meeting-store.ts');
  const types = read('src/types.ts');
  assert.match(preload, /meeting-delivery:get/);
  assert.match(preload, /meeting-delivery:accept/);
  assert.match(preload, /meeting-delivery:request-rework/);
  assert.match(store, /e\.kind === 'meeting-delivery-updated'/);
  assert.match(types, /interface MeetingDelivery/);
  assert.match(types, /FinalMeetingDecision/);
});
