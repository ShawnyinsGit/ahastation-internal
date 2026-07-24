import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Activity,
  Braces,
  CheckCircle2,
  FileDiff,
  GitMerge,
  LayoutDashboard,
  MessageSquareText,
  ShieldAlert,
  X,
} from 'lucide-react';
import {
  meetingStore,
  type WorkerState,
} from '../lib/meeting-store';
import type { RendererTaskSnapshot } from '../types';
import { BackendAvatar } from './BackendAvatar';
import { PermissionCard } from './PermissionCard';
import { TaskMailboxPanel } from './TaskMailboxPanel';
import { TaskProfilePanel } from './TaskProfilePanel';
import { TaskReviewPanel } from './TaskReviewPanel';

const TASK_INSPECTOR_TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'context', label: 'Context', icon: Braces },
  { id: 'messages', label: 'Messages', icon: MessageSquareText },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'diff', label: 'Diff Review', icon: FileDiff },
  { id: 'verification', label: 'Verification', icon: CheckCircle2 },
  { id: 'permissions', label: 'Permissions', icon: ShieldAlert },
  { id: 'integration', label: 'Integration', icon: GitMerge },
] as const;

type InspectorTab = (typeof TASK_INSPECTOR_TABS)[number]['id'];

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  pending: '等待调度',
  running: '执行中',
  verifying: '验证中',
  reviewing: 'Coordinator 审查中',
  'coordinator-reviewing': 'Coordinator 审查中',
  'awaiting-acceptance': '等待验收',
  'integration-queued': '等待集成',
  integrating: '集成中',
  reworking: '返工中',
  accepted: '已集成',
  interrupted: '已中断',
  done: '已完成',
  blocked: '已阻塞',
  'integration-conflict': '集成冲突',
  'budget-paused': '预算暂停',
  failed: '失败',
  cancelled: '已取消',
};

function backendIconId(backendId: string): string {
  if (backendId.includes('claude')) return 'claude';
  if (backendId.includes('codex')) return 'codex';
  if (backendId.includes('kimi')) return 'kimi';
  if (backendId.includes('qoder')) return 'qoder';
  return backendId;
}

function ContextDetails({ snapshot }: { snapshot: RendererTaskSnapshot }) {
  return (
    <div className="task-context-details">
      <section>
        <span>Frozen context</span>
        <strong>{snapshot.task.context?.packageHash?.slice(0, 12) ?? '未冻结'}</strong>
        <dl>
          <div><dt>Messages</dt><dd>{snapshot.task.context?.messageCount ?? 0}</dd></div>
          <div><dt>Decisions</dt><dd>{snapshot.task.context?.decisionCount ?? 0}</dd></div>
          <div><dt>Dependencies</dt><dd>{snapshot.task.context?.dependencyReportCount ?? 0}</dd></div>
          <div><dt>Attachments</dt><dd>{snapshot.task.context?.attachmentCount ?? 0}</dd></div>
        </dl>
      </section>
      <section>
        <span>Acceptance criteria</span>
        {snapshot.task.acceptanceCriteria?.length ? (
          <ol>
            {snapshot.task.acceptanceCriteria.map((criterion, index) => (
              <li key={index}>
                {typeof criterion === 'object' && criterion
                  ? String((criterion as Record<string, unknown>).description ?? `Criterion ${index + 1}`)
                  : String(criterion)}
              </li>
            ))}
          </ol>
        ) : (
          <p className="task-empty-state">没有可展示的验收条件。</p>
        )}
      </section>
      <section>
        <span>Dependencies</span>
        <div className="task-dependency-chips">
          {snapshot.task.deps.length
            ? snapshot.task.deps.map((dependency) => <code key={dependency}>{dependency}</code>)
            : <small>无前置依赖</small>}
        </div>
      </section>
    </div>
  );
}

export function TaskInspector({
  sessionId,
  taskId,
  worker,
  onClose,
  onResolvePermission,
}: {
  sessionId: string;
  taskId: string;
  worker?: WorkerState;
  onClose: () => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => void;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const getProjection = useCallback(
    () => meetingStore.getTaskInspectorProjection(sessionId, taskId),
    [sessionId, taskId],
  );
  const projection = useSyncExternalStore(
    meetingStore.subscribeTaskInspectors,
    getProjection,
    getProjection,
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setActiveTab('overview');
    void meetingStore.openTaskInspector(sessionId, taskId).then((result) => {
      if (!active) return;
      setLoading(false);
      if (!result.ok) setLoadError(result.error);
    });
    return () => {
      active = false;
      meetingStore.closeTaskInspector(sessionId, taskId);
    };
  }, [sessionId, taskId]);

  const snapshot = projection?.snapshot ?? null;
  const activity = projection?.activity ?? [];
  const status = snapshot?.task.status ?? worker?.status ?? 'pending';
  const pendingPermission = worker?.pendingPermission ?? null;

  return (
    <aside className="task-inspector" aria-label="Task Inspector">
      <header className="task-inspector-header">
        <div className="task-inspector-identity">
          <BackendAvatar
            iconId={backendIconId(snapshot?.task.backendId ?? worker?.backendId ?? 'worker')}
            size={34}
          />
          <div>
            <span>Task Inspector</span>
            <strong>{snapshot?.task.title ?? worker?.title ?? taskId}</strong>
            <small>
              {snapshot?.task.backendId ?? worker?.backendId ?? 'Backend 未知'}
              {' · '}
              Attempt {snapshot?.task.attempt ?? worker?.attempt ?? 1}
            </small>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭 Task Inspector">
          <X size={17} />
        </button>
      </header>

      <div className="task-inspector-statusline">
        <span className={`task-status-mark is-${status}`} aria-hidden />
        <strong>{STATUS_LABEL[status] ?? status}</strong>
        {pendingPermission && (
          <span className="task-risk-pill"><ShieldAlert size={12} /> 高风险确认</span>
        )}
        {projection?.needsRefresh && <span className="task-refresh-pill">正在刷新事件缺口</span>}
      </div>

      <nav className="task-inspector-tabs" aria-label="Task Inspector sections">
        {TASK_INSPECTOR_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={activeTab === id ? 'is-active' : ''}
            onClick={() => setActiveTab(id)}
            aria-selected={activeTab === id}
            role="tab"
          >
            <Icon size={14} />
            <span>{label}</span>
            {id === 'permissions' && pendingPermission && <i aria-label="有待处理权限" />}
          </button>
        ))}
      </nav>

      <div className="task-inspector-body">
        {loading && !snapshot && <div className="task-inspector-loading">正在恢复任务事实…</div>}
        {loadError && <div className="task-inspector-error" role="alert">{loadError}</div>}
        {snapshot && activeTab === 'overview' && (
          <div className="task-overview">
            <section className="task-overview-hero">
              <span>Objective</span>
              <p>{snapshot.task.prompt}</p>
            </section>
            <div className="task-overview-metrics">
              <article><span>Attempt</span><strong>{snapshot.task.attempt}</strong></article>
              <article><span>Mailbox</span><strong>{snapshot.mailbox.length}</strong></article>
              <article><span>Events</span><strong>{activity.length}</strong></article>
              <article><span>Dependencies</span><strong>{snapshot.task.deps.length}</strong></article>
            </div>
            <TaskProfilePanel snapshot={snapshot} />
            {snapshot.diagnostics.length > 0 && (
              <section className="task-diagnostic-list">
                <header>Recovery diagnostics</header>
                {snapshot.diagnostics.map((diagnostic, index) => (
                  <p key={`${diagnostic.code}:${index}`}>
                    <strong>{diagnostic.code}</strong> {diagnostic.message}
                  </p>
                ))}
              </section>
            )}
          </div>
        )}
        {snapshot && activeTab === 'context' && <ContextDetails snapshot={snapshot} />}
        {snapshot && activeTab === 'messages' && (
          <TaskMailboxPanel sessionId={sessionId} taskId={taskId} snapshot={snapshot} />
        )}
        {snapshot && activeTab === 'activity' && (
          <ol className="task-activity-timeline">
            {activity.length ? activity.map((event) => (
              <li key={event.eventId}>
                <span className={`task-status-mark is-${event.type}`} />
                <div>
                  <strong>{event.type}</strong>
                  <small>seq {event.seq} · attempt {event.attempt ?? snapshot.task.attempt}</small>
                </div>
                <time>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              </li>
            )) : <li className="task-empty-state">没有新的任务事件。</li>}
          </ol>
        )}
        {snapshot && activeTab === 'diff' && <TaskReviewPanel snapshot={snapshot} mode="diff" />}
        {snapshot && activeTab === 'verification' && (
          <TaskReviewPanel snapshot={snapshot} mode="verification" />
        )}
        {snapshot && activeTab === 'permissions' && (
          pendingPermission ? (
            <PermissionCard pending={pendingPermission} onDecide={onResolvePermission} />
          ) : (
            <div className="task-permission-clear">
              <CheckCircle2 size={24} />
              <strong>没有待处理权限</strong>
              <p>计划范围内的低风险操作由 Coordinator 自动批准；高风险操作始终在这里确认。</p>
            </div>
          )
        )}
        {snapshot && activeTab === 'integration' && (
          <TaskReviewPanel snapshot={snapshot} mode="integration" />
        )}
      </div>
    </aside>
  );
}
