import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('task board focus and worker tiles open the docked inspector beside the meeting surface', () => {
  const stage = read('src/components/ScreenStage.tsx');
  const board = read('src/components/TasksView.tsx');
  const activity = read('src/components/ActivityTabContent.tsx');
  const userTasks = read('src/components/UserTasksPanel.tsx');
  const windows = read('src/lib/stage-window-store.ts');
  assert.match(stage, /selectedTaskId/);
  assert.match(stage, /focusTask/);
  assert.match(stage, /handleSelectTask/);
  assert.match(stage, /inspectorOpenSeq/);
  assert.match(stage, /openSeq=\{inspectorOpenSeq\}/);
  assert.match(stage, /onOpenTask=\{handleSelectTask\}/);
  assert.match(stage, /<TaskInspector/);
  assert.match(stage, /<ActivityTabContent/);
  assert.doesNotMatch(stage, /<TaskRail/);
  assert.match(board, /onOpenTask/);
  assert.match(activity, /onOpenTask=\{onOpenTask\}/);
  assert.match(userTasks, /onOpenTask\?: \(taskId: string\) => void/);
  assert.match(windows, /title: '工作区'/);
  assert.doesNotMatch(windows, /title: '活动'/);
});

test('Task Inspector exposes every required evidence section', () => {
  const inspector = read('src/components/TaskInspector.tsx');
  for (const tab of [
    'Overview',
    'Context',
    'Messages',
    'Events',
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

test('bounded rework budget and explicit user extension stay visible', () => {
  const inspector = read('src/components/TaskInspector.tsx');
  assert.match(inspector, /Bounded rework budget/);
  assert.match(inspector, /budget-paused/);
  assert.match(inspector, /不设预算并继续/);
  assert.match(inspector, /只加一次返工额度/);
  assert.match(inspector, /tasks\.extendBudget/);
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
  const approval = read('src/components/ApprovalCard.tsx');
  const detail = read('src/components/ApprovalDetailModal.tsx');
  const review = read('src/components/TaskReviewPanel.tsx');
  assert.match(inspector, /高风险确认/);
  assert.match(approval, /需进入详情/);
  assert.match(detail, /高风险操作 · 需完整确认/);
  assert.match(detail, /我已阅读/);
  assert.match(inspector, /确认已人工检查/);
  assert.match(inspector, /tasks\.confirmReviewEvidence/);
  assert.match(inspector, /该内容不会发送给 Coordinator 模型/);
  assert.match(review, /没有逐任务用户验收按钮/);
  assert.doesNotMatch(inspector, /acceptDelivery|通过 · 验收/);
});

test('a stalled Coordinator review is surfaced as unfinished, never as a pass', () => {
  const inspector = read('src/components/TaskInspector.tsx');
  assert.match(inspector, /Coordinator 审查未完成/);
  assert.match(inspector, /交付没有通过，也不会自动通过/);
  assert.match(inspector, /让 Coordinator 继续审查/);
  assert.match(inspector, /tasks\.resumeReview/);
});

test('task statuses include text and icon semantics rather than color alone', () => {
  const columns = read('src/lib/task-columns.ts');
  const board = read('src/components/TasksView.tsx');
  assert.match(columns, /WORKER_STATUS_LABEL/);
  assert.match(board, /function StatusIcon/);
  assert.match(board, /task\.statusLabel|task\.blockedReason/);
});

test('task board prefers live worker status over lagging plan nodes', () => {
  const columns = read('src/lib/task-columns.ts');
  const store = read('src/lib/meeting-store.ts');
  const stage = read('src/components/ScreenStage.tsx');
  assert.match(columns, /export function resolveBoardTaskStatus/);
  assert.match(store, /resolveBoardTaskStatus\(node\.status, worker\?\.status\)/);
  // Cross-project open must arm awaitingFocus before selection, or the
  // plan-sweep clears the inspector while the target session's plan swaps in.
  assert.match(stage, /awaitingFocus\.current = focusTaskId;\s*setSelectedTaskId\(focusTaskId\)/);
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
