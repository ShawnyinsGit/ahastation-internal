// WorkerWorkbench - single-worker workbench for a claude-code-terminal worker.
//
// Left: Claude Code's native TUI via RealTerminal (xterm). Right: a host
// collaboration sidebar that consolidates the high-frequency info currently
// scattered across the TaskInspector dock tabs - task context, the terminal
// turn-ended confirm bar, the host<->worker mailbox (with Follow-up / Steering
// / Interrupt), and the worker's delivery status with Accept / Revise. The
// human supervises the TUI and steps in through the sidebar; deep review
// (diff / verification / permissions) still opens the full TaskInspector dock
// via onOpenInspector.

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { meetingStore, type DeliverySnapshot, type WorkerState } from '../lib/meeting-store';
import { useMeetingSelector } from '../hooks/useMeetingSelector';
import type { RendererTaskSnapshot } from '../types';
import { RealTerminal } from './RealTerminal';
import { TerminalTurnConfirmBar } from './TerminalTurnConfirmBar';
import { TaskMailboxPanel } from './TaskMailboxPanel';

const STATUS_LABEL: Record<string, string> = {
  idle: '空闲',
  pending: '等待调度',
  running: '执行中',
  verifying: '验证中',
  reviewing: '审查中',
  'coordinator-reviewing': 'Coordinator 审查中',
  'awaiting-acceptance': '待人手确认',
  'awaiting-delivery-acceptance': '待人手确认',
  'integration-queued': '等待集成',
  integrating: '集成中',
  reworking: '返工中',
  accepted: '已进 Meeting 分支',
  interrupted: '已中断',
  done: '已完成',
  blocked: '已阻塞',
  'integration-conflict': '集成冲突',
  'budget-paused': '预算暂停',
  failed: '失败',
  cancelled: '已取消',
};

interface WorkerWorkbenchProps {
  workerId: string;
  sessionId: string;
  onOpenInspector: (workerId: string) => void;
  onAcceptDelivery: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onReviseDelivery: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
}

export function WorkerWorkbench({
  workerId,
  sessionId,
  onOpenInspector,
  onAcceptDelivery,
  onReviseDelivery,
}: WorkerWorkbenchProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const worker = useMeetingSelector((s) => s.workers.get(workerId));
  const currentDelivery = useMeetingSelector(
    (s) =>
      s.currentDelivery && s.currentDelivery.workerId === workerId
        ? s.currentDelivery
        : null,
  );

  // Task projection (mailbox + snapshot) - same refcounted pattern as the
  // docked TaskInspector. Mount opens, unmount closes; both can be open at once.
  const getProjection = useCallback(
    () => meetingStore.getTaskInspectorProjection(sessionId, workerId),
    [sessionId, workerId],
  );
  const projection = useSyncExternalStore(
    meetingStore.subscribeTaskInspectors,
    getProjection,
    getProjection,
  );
  useEffect(() => {
    let active = true;
    void meetingStore.openTaskInspector(sessionId, workerId).then((result) => {
      if (!active) return;
      // Projection is shared via the store; nothing to do on success. A failure
      // here just leaves the sidebar sections empty until the next retry.
      void result;
    });
    return () => {
      active = false;
      meetingStore.closeTaskInspector(sessionId, workerId);
    };
  }, [sessionId, workerId]);

  const snapshot = projection?.snapshot ?? null;
  const status = worker?.status ?? snapshot?.task.status ?? 'pending';

  return (
    <div
      className={`worker-workbench${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}
      data-status={status}
    >
      <div className="worker-workbench-terminal">
        <RealTerminal workerId={workerId} />
      </div>

      <aside className="worker-workbench-sidebar" aria-label="Host 协作侧栏">
        <div className="worker-workbench-sidebar-head">
          <strong>协作</strong>
          <button
            type="button"
            className="worker-workbench-collapse"
            onClick={() => setSidebarCollapsed(true)}
            aria-label="收起侧栏"
            title="收起侧栏"
          >
            ›
          </button>
        </div>

        {worker && <TerminalTurnConfirmBar sessionId={sessionId} worker={worker} />}

        {snapshot && <WorkbenchTaskContext snapshot={snapshot} status={status} />}

        {snapshot && (
          <TaskMailboxPanel sessionId={sessionId} taskId={workerId} snapshot={snapshot} />
        )}

        <WorkbenchDeliverySummary
          delivery={currentDelivery}
          onAccept={onAcceptDelivery}
          onRevise={onReviseDelivery}
        />

        <button
          type="button"
          className="workbench-open-inspector"
          onClick={() => onOpenInspector(workerId)}
        >
          展开完整检查器
        </button>
      </aside>

      {sidebarCollapsed && (
        <button
          type="button"
          className="worker-workbench-expand"
          onClick={() => setSidebarCollapsed(false)}
          aria-label="展开侧栏"
          title="展开侧栏"
        >
          ‹
        </button>
      )}
    </div>
  );
}

function WorkbenchTaskContext({
  snapshot,
  status,
}: {
  snapshot: RendererTaskSnapshot;
  status: string;
}) {
  const task = snapshot.task;
  return (
    <section className="workbench-section workbench-context">
      <header>
        <strong>任务</strong>
        <span className={`workbench-status-chip is-${status}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </header>
      <p className="workbench-objective">{task.prompt}</p>
      <div className="workbench-metrics">
        <span>Attempt {task.attempt}</span>
        <span>Mailbox {snapshot.mailbox.length}</span>
        {task.deps.length > 0 && <span>依赖 {task.deps.length}</span>}
      </div>
      {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
        <details className="workbench-details">
          <summary>验收条件（{task.acceptanceCriteria.length}）</summary>
          <ol>
            {task.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>
                {typeof criterion === 'object' && criterion
                  ? String(
                      (criterion as Record<string, unknown>).description ??
                        `Criterion ${index + 1}`,
                    )
                  : String(criterion)}
              </li>
            ))}
          </ol>
        </details>
      )}
      {task.deps.length > 0 && (
        <details className="workbench-details">
          <summary>依赖</summary>
          <div className="task-dependency-chips">
            {task.deps.map((dependency) => (
              <code key={dependency}>{dependency}</code>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function WorkbenchDeliverySummary({
  delivery,
  onAccept,
  onRevise,
}: {
  delivery: DeliverySnapshot | null;
  onAccept: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRevise: (feedback: string) => Promise<
    | { ok: true; route: 'worker' | 'talker'; queued?: boolean }
    | { ok: false; error: string }
  >;
}) {
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState<'' | 'accept' | 'revise'>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  if (!delivery) return null;

  const canDecide = delivery.status === 'awaiting-delivery-acceptance';
  const statusLabel = STATUS_LABEL[delivery.status] ?? delivery.status;

  const accept = async () => {
    setError('');
    setNote('');
    setPending('accept');
    try {
      const result = await onAccept();
      if (!result.ok) setError(result.error);
      else setNote('已接受交付。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending('');
    }
  };

  const revise = async () => {
    const text = feedback.trim();
    if (!text) return;
    setError('');
    setNote('');
    setPending('revise');
    try {
      const result = await onRevise(text);
      if (!result.ok) setError(result.error);
      else {
        setNote(result.queued ? '返工已排队。' : '已请求返工。');
        setFeedback('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending('');
    }
  };

  return (
    <section className="workbench-section workbench-delivery">
      <header>
        <strong>交付</strong>
        <span className={`workbench-status-chip is-${delivery.status}`}>
          {statusLabel}
        </span>
      </header>
      <p className="workbench-delivery-summary">{delivery.summary || '（无摘要）'}</p>
      {delivery.files.length > 0 && (
        <p className="workbench-delivery-files">
          {delivery.files.length} 个文件 · attempt {delivery.attempt}
        </p>
      )}
      {canDecide && (
        <div className="workbench-delivery-actions">
          <button
            type="button"
            className="is-primary"
            disabled={pending !== ''}
            onClick={() => void accept()}
          >
            {pending === 'accept' ? '提交中…' : '接受交付'}
          </button>
          <textarea
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="返工反馈（必填）"
            maxLength={100_000}
            disabled={pending !== ''}
          />
          <button
            type="button"
            className="is-danger"
            disabled={pending !== '' || !feedback.trim()}
            onClick={() => void revise()}
          >
            {pending === 'revise' ? '提交中…' : '请求返工'}
          </button>
        </div>
      )}
      {note && <p className="workbench-note" role="status">{note}</p>}
      {error && <p className="workbench-error" role="alert">{error}</p>}
    </section>
  );
}
