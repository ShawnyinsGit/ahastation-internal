import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('selecting a Task Rail node opens the docked inspector beside the meeting surface', () => {
  const stage = read('src/components/ScreenStage.tsx');
  const rail = read('src/components/TaskRail.tsx');
  assert.match(stage, /selectedTaskId/);
  assert.match(stage, /onSelect=\{handleSelectTask\}/);
  assert.match(stage, /<TaskInspector/);
  assert.match(stage, /<ActivityTabContent/);
  assert.match(rail, /aria-pressed=\{selectedId === node\.id\}/);
});

test('Task Inspector exposes every required evidence section', () => {
  const inspector = read('src/components/TaskInspector.tsx');
  for (const tab of [
    'Overview',
    'Context',
    'Messages',
    'Activity',
    'Diff Review',
    'Verification',
    'Permissions',
    'Integration',
  ]) {
    assert.match(inspector, new RegExp(`label: '${tab}'`));
  }
  assert.match(inspector, /TaskProfilePanel/);
  assert.match(inspector, /TaskMailboxPanel/);
  assert.match(inspector, /TaskReviewPanel/);
});

test('requested and effective profiles and delivery states remain visible', () => {
  const profile = read('src/components/TaskProfilePanel.tsx');
  const mailbox = read('src/components/TaskMailboxPanel.tsx');
  assert.match(profile, /Requested profile/);
  assert.match(profile, /Effective profile/);
  for (const state of ['排队中', '已送达', '已确认', '待重试']) {
    assert.match(mailbox, new RegExp(state));
  }
});

test('Follow-up, Steering and Interrupt are distinct task controls', () => {
  const mailbox = read('src/components/TaskMailboxPanel.tsx');
  assert.match(mailbox, /> Follow-up</);
  assert.match(mailbox, /> Steering</);
  assert.match(mailbox, /Interrupt Task/);
  assert.match(mailbox, /tasks\.followUp/);
  assert.match(mailbox, /tasks\.steer/);
  assert.match(mailbox, /tasks\.interrupt/);
});

test('high-risk approval is visible and normal mode has no per-task accept action', () => {
  const inspector = read('src/components/TaskInspector.tsx');
  const permission = read('src/components/PermissionCard.tsx');
  const review = read('src/components/TaskReviewPanel.tsx');
  assert.match(inspector, /高风险确认/);
  assert.match(permission, /High-risk approval/);
  assert.match(permission, /高风险操作不会被 Coordinator 自动批准/);
  assert.match(review, /没有逐任务用户验收按钮/);
  assert.doesNotMatch(inspector, /acceptDelivery|通过 · 验收/);
});

test('task statuses include text and icon semantics rather than color alone', () => {
  const rail = read('src/components/TaskRail.tsx');
  assert.match(rail, /const LABEL: Record<WorkerStatus, string>/);
  assert.match(rail, /function StatusIcon/);
  assert.match(rail, /aria-label=\{`\$\{label\}/);
});

test('compact widths use an in-window drawer and never open a separate inspector window', () => {
  const css = read('src/styles.css');
  const stage = read('src/components/ScreenStage.tsx');
  assert.match(css, /@media \(max-width: 1024px\), \(pointer: coarse\)/);
  assert.match(css, /\.stage > \.task-inspector-dock \{[\s\S]*position: absolute/);
  assert.match(css, /\.task-inspector-dock\.is-task-inspector-fullscreen/);
  assert.doesNotMatch(stage, /window\.open|BrowserWindow|popoutTaskInspector/);
});

test('development fixture provides deterministic Task Inspector snapshots', () => {
  const fixture = read('src/dev-fixture-bootstrap.ts');
  assert.match(fixture, /tasks: \{/);
  assert.match(fixture, /getSnapshot: async/);
  assert.match(fixture, /reviewCoverage: \{ reviewedChunks: 7, totalChunks: 9/);
  assert.match(fixture, /candidateCommit: '514ee30a144ce8a4'/);
});
