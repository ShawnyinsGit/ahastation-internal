// Inline panel listing tasks the user has dispatched this meeting.
//
// Data flow: meeting-store keeps every spawned worker in `state.workers`. Each
// non-talker worker IS a task the user asked for — the talker received the
// utterance, then either called delegate_task or plan_meeting which spawned
// the worker. So "tasks the user requested" = workers minus the talker.
//
// Rendered in the gallery detail area (same slot as ClaudeWorkspace) when the
// user clicks their own participant tile — replaces the old modal so the UX
// matches clicking any other participant.

import { useState } from 'react';
import type { WorkerState } from '../lib/meeting-store';
import {
  dependencyGateShortLabel,
  type DependencyGate,
} from '../lib/dependency-gate';
import { WORKER_STATUS_LABEL } from '../lib/task-columns';
import type { MeetingPlan, WorkerStatus } from '../types';

interface UserTasksPanelProps {
  workers: WorkerState[];
  plan?: MeetingPlan | null;
  sessionId?: string | null;
  /** Open the docked Task Inspector for a meeting-local task row. */
  onOpenTask?: (taskId: string) => void;
}

interface TaskRow {
  id: string;
  title: string;
  status: WorkerStatus | 'idle';
  owner: string;
  detail: string;
  dependencyGate: DependencyGate;
  recovery?: MeetingPlan['nodes'][number]['recovery'];
}

const STATUS_LABEL: Record<TaskRow['status'], string> = {
  idle: '空闲',
  ...WORKER_STATUS_LABEL,
};

const STATUS_TONE: Record<TaskRow['status'], string> = {
  idle: 'task-status-idle',
  pending: 'task-status-pending',
  interrupted: 'task-status-pending',
  running: 'task-status-running',
  verifying: 'task-status-running',
  reviewing: 'task-status-running',
  'coordinator-reviewing': 'task-status-running',
  'awaiting-acceptance': 'task-status-pending',
  'integration-queued': 'task-status-pending',
  integrating: 'task-status-running',
  'integration-conflict': 'task-status-failed',
  reworking: 'task-status-failed',
  'budget-paused': 'task-status-pending',
  accepted: 'task-status-done',
  done: 'task-status-done',
  failed: 'task-status-failed',
};

function buildRows(workers: WorkerState[], plan?: MeetingPlan | null): TaskRow[] {
  const planById = new Map((plan?.nodes ?? []).map((node) => [node.id, node]));
  const rows = workers
    .filter((w) => w.role !== 'talker')
    .map((w) => {
      const node = planById.get(w.id);
      return {
        id: w.id,
        title: w.title || w.id,
        status: w.status,
        owner: w.id,
        detail: w.summary || w.lastText || '',
        dependencyGate: node?.dependencyGate === 'reviewed' ? 'reviewed' as const : 'accepted' as const,
        recovery: node?.recovery,
      };
    })
    .reverse();
  const known = new Set(rows.map((row) => row.id));
  for (const node of plan?.nodes ?? []) {
    if (!known.has(node.id)) rows.push({
      id: node.id, title: node.title, status: node.status,
      owner: 'recovery',
      detail: node.status === 'interrupted' ? 'Recovered after restart; choose how to proceed.' : '',
      dependencyGate: node.dependencyGate === 'reviewed' ? 'reviewed' : 'accepted',
      recovery: node.recovery,
    });
  }
  return rows;
}

export function UserTasksPanel({ workers, plan, sessionId, onOpenTask }: UserTasksPanelProps) {
  const rows = buildRows(workers, plan);
  const [pendingRecovery, setPendingRecovery] = useState<{
    taskId: string;
    action: 'continue-side-effecting' | 'retry-attempt';
  } | null>(null);
  const [recoveryError, setRecoveryError] = useState('');

  const resolveInterrupted = async (
    taskId: string,
    action:
      | 'continue-side-effecting'
      | 'retry-attempt'
      | 'resolve-integration-conflict'
      | 'abandon-task',
  ) => {
    setRecoveryError('');
    const result = await window.vibeMeet.sessions.resolveRecoveredTask(sessionId ?? null, taskId, action);
    if (!result.ok) setRecoveryError(result.error);
    else setPendingRecovery(null);
  };

  return (
    <div className="user-tasks-inline" role="region" aria-label="Your tasks this meeting">
      <div className="user-tasks-head">
        <div className="user-tasks-title-main">你这场会议派出的任务</div>
        <div className="user-tasks-subtitle">由 host 拆解后派给各 worker · 共 {rows.length} 项</div>
      </div>

      <div className="user-tasks-body">
        {rows.length === 0 ? (
          <div className="user-tasks-empty">
            <div className="user-tasks-empty-title">尚无任务派发</div>
            <div className="user-tasks-empty-sub">
              Host 还在处理你的请求。说一个具体诉求，他就会拆成 worker 派出去。
            </div>
          </div>
        ) : (
          <table className="user-tasks-table">
            <thead>
              <tr>
                <th className="user-tasks-col-title">任务</th>
                <th className="user-tasks-col-status">状态</th>
                <th className="user-tasks-col-owner">负责人</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={onOpenTask ? 'user-tasks-row-openable' : undefined}
                  onClick={onOpenTask ? () => onOpenTask(row.id) : undefined}
                  role={onOpenTask ? 'button' : undefined}
                  tabIndex={onOpenTask ? 0 : undefined}
                  onKeyDown={onOpenTask ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenTask(row.id);
                    }
                  } : undefined}
                >
                  <td className="user-tasks-col-title">
                    <div className="user-tasks-title">{row.title}</div>
                    {row.detail && (
                      <div className="user-tasks-detail" title={row.detail}>
                        {row.detail}
                      </div>
                    )}
                  </td>
                  <td className="user-tasks-col-status">
                    <div className="user-tasks-status-stack">
                      <span className={`user-tasks-pill ${STATUS_TONE[row.status]}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                      <span className={`user-tasks-gate is-${row.dependencyGate}`}>
                        {dependencyGateShortLabel(row.dependencyGate)}
                      </span>
                    </div>
                    {row.status === 'interrupted' && (
                      <>
                        <div className="user-tasks-recovery-actions" onClick={(event) => event.stopPropagation()}>
                          {row.recovery?.allowedActions.includes('continue-side-effecting') && (
                            <button type="button" onClick={() => setPendingRecovery({ taskId: row.id, action: 'continue-side-effecting' })}>继续</button>
                          )}
                          {row.recovery?.allowedActions.includes('continue-read-only') && (
                            <button
                              type="button"
                              onClick={() => {
                                void window.vibeMeet.sessions.resolveRecoveredTask(
                                  sessionId ?? null,
                                  row.id,
                                  'continue-read-only',
                                );
                              }}
                            >
                              继续只读任务
                            </button>
                          )}
                          <button type="button" onClick={() => setPendingRecovery({ taskId: row.id, action: 'retry-attempt' })}>重跑</button>
                          <button type="button" onClick={() => { void resolveInterrupted(row.id, 'abandon-task'); }}>放弃</button>
                        </div>
                        {pendingRecovery?.taskId === row.id && (
                          <div
                            className="user-tasks-recovery-confirm"
                            role="alert"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <strong>{pendingRecovery.action === 'continue-side-effecting' ? '从现有工作区继续' : '创建新的重跑 attempt'}</strong>
                            <p>这是显式的用户恢复决定。系统不会在确认前发送 Backend prompt，也不会重放命令、网络或外部副作用。</p>
                            <div>
                              <button type="button" onClick={() => setPendingRecovery(null)}>取消</button>
                              <button
                                type="button"
                                className="is-primary"
                                onClick={() => {
                                  void resolveInterrupted(row.id, pendingRecovery.action);
                                }}
                              >
                                确认{pendingRecovery.action === 'continue-side-effecting' ? '继续' : '重跑'}
                              </button>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    {row.status === 'integration-conflict' && (
                      <div className="user-tasks-recovery-actions" onClick={(event) => event.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => { void resolveInterrupted(row.id, 'resolve-integration-conflict'); }}
                        >
                          中止队列冲突并恢复
                        </button>
                        <button
                          type="button"
                          onClick={() => { void resolveInterrupted(row.id, 'abandon-task'); }}
                        >
                          放弃
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="user-tasks-col-owner">
                    <span className="user-tasks-owner">{row.owner}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {recoveryError && <div className="user-tasks-recovery-error" role="alert">{recoveryError}</div>}
    </div>
  );
}
