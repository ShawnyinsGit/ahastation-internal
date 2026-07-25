// Shared vocabulary for anything that renders a task's state — the
// cross-project TasksView (and any future surfaces) read from here so a
// status never gets two different Chinese labels.

import type { WorkerStatus } from '../types';

export const WORKER_STATUS_LABEL: Record<WorkerStatus, string> = {
  pending: '等待调度',
  running: '执行中',
  verifying: '校验中',
  reviewing: '评审中',
  'coordinator-reviewing': 'Coordinator 审查中',
  'awaiting-acceptance': '等待验收',
  'integration-queued': '等待集成',
  integrating: '集成中',
  'integration-conflict': '集成冲突',
  reworking: '需要返工',
  'budget-paused': '预算暂停',
  accepted: '已接受',
  interrupted: '已中断',
  done: '已完成',
  failed: '失败',
};

export type TaskColumnId = 'attention' | 'active' | 'review' | 'settled';

export interface TaskColumnMeta {
  id: TaskColumnId;
  title: string;
  hint: string;
}

export const TASK_COLUMNS: readonly TaskColumnMeta[] = [
  { id: 'attention', title: '待批准', hint: '卡在你这里' },
  { id: 'active', title: '进行中', hint: 'Worker 正在推进' },
  { id: 'review', title: '待验收', hint: '交付已就绪' },
  { id: 'settled', title: '已完成', hint: '终态' },
];

const SETTLED: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  'accepted',
  'done',
  'failed',
  'interrupted',
]);

/** Which board column a task belongs in. `blocked` covers anything that needs a
 *  human before the task can move — a pending permission prompt or a workspace
 *  diagnostic — and is decided by the caller because it lives on the worker,
 *  not the plan node. Statuses that halt on their own (budget exhausted,
 *  integration conflict) are treated the same way. */
export function columnForTask(status: WorkerStatus, blocked: boolean): TaskColumnId {
  if (blocked || status === 'budget-paused' || status === 'integration-conflict') {
    return 'attention';
  }
  if (status === 'awaiting-acceptance') return 'review';
  if (SETTLED.has(status)) return 'settled';
  return 'active';
}

/** Prefer the live worker status over the plan-node snapshot. `delivery-status`
 *  / `worker-ended` update workers immediately; `plan-updated` can lag a tick
 *  behind, which made the cross-project board disagree with the in-meeting
 *  task list. Idle is a talker/blank placeholder and never wins. */
export function resolveBoardTaskStatus(
  nodeStatus: WorkerStatus,
  workerStatus: WorkerStatus | 'idle' | undefined,
): WorkerStatus {
  if (workerStatus && workerStatus !== 'idle') return workerStatus;
  return nodeStatus;
}

/** Last path segment of a cwd, tolerant of both separators. Falls back to the
 *  whole string for degenerate inputs like a bare drive root. */
export function projectNameFromCwd(cwd: string): string {
  const segments = cwd.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? cwd;
}
