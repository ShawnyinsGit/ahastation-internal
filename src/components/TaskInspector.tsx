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
import { ApprovalCard } from './ApprovalCard';
import { TaskMailboxPanel } from './TaskMailboxPanel';
import { TaskProfilePanel } from './TaskProfilePanel';
import { TaskReviewPanel } from './TaskReviewPanel';

const TASK_INSPECTOR_TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'context', label: 'Context', icon: Braces },
  { id: 'messages', label: 'Messages', icon: MessageSquareText },
  { id: 'activity', label: 'Events', icon: Activity },
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
  openSeq = 0,
  worker,
  onClose,
  onResolvePermission,
}: {
  sessionId: string;
  taskId: string;
  /** Incremented by the stage whenever the inspector is (re)opened so Overview is restored. */
  openSeq?: number;
  worker?: WorkerState;
  onClose: () => void;
  onResolvePermission: (id: string, decision: 'allow' | 'deny') => Promise<{ ok: true } | { ok: false; error: string }> | void;
}) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('overview');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reviewConfirmationError, setReviewConfirmationError] = useState('');
  const [confirmingChunkId, setConfirmingChunkId] = useState('');
  const [resumingReview, setResumingReview] = useState(false);
  const [budgetExtensionError, setBudgetExtensionError] = useState('');
  const [extendingBudget, setExtendingBudget] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [resolvingRecovery, setResolvingRecovery] = useState('');
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

  useEffect(() => {
    setActiveTab('overview');
  }, [openSeq]);

  const snapshot = projection?.snapshot ?? null;
  const activity = projection?.activity ?? [];
  const status = snapshot?.task.status ?? worker?.status ?? 'pending';
  const pendingPermission = worker?.pendingPermission ?? null;
  const pendingReviewEvidence = snapshot?.reviewEvidence?.pending ?? [];
  const stalledReview = snapshot?.reviewEvidence?.status === 'paused'
    ? snapshot.reviewEvidence
    : null;

  const resumeReview = useCallback(async (reviewId: string) => {
    setReviewConfirmationError('');
    setResumingReview(true);
    try {
      const result = await window.vibeMeet.tasks.resumeReview(sessionId, taskId, reviewId);
      if (!result.ok) {
        setReviewConfirmationError(result.error ?? '恢复审查失败');
        return;
      }
      const refreshed = await meetingStore.openTaskInspector(sessionId, taskId);
      if (!refreshed.ok) setReviewConfirmationError(refreshed.error);
    } catch (error) {
      setReviewConfirmationError(error instanceof Error ? error.message : '恢复审查失败');
    } finally {
      setResumingReview(false);
    }
  }, [sessionId, taskId]);

  const confirmReviewEvidence = useCallback(async (
    reviewId: string,
    chunkId: string,
    chunkHash: string,
  ) => {
    setReviewConfirmationError('');
    setConfirmingChunkId(chunkId);
    try {
      const result = await window.vibeMeet.tasks.confirmReviewEvidence(
        sessionId,
        taskId,
        reviewId,
        chunkId,
        chunkHash,
      );
      if (!result.ok) {
        setReviewConfirmationError(result.error ?? '确认失败');
        return;
      }
      const refreshed = await meetingStore.openTaskInspector(sessionId, taskId);
      if (!refreshed.ok) setReviewConfirmationError(refreshed.error);
    } catch (error) {
      setReviewConfirmationError(error instanceof Error ? error.message : '确认失败');
    } finally {
      setConfirmingChunkId('');
    }
  }, [sessionId, taskId]);

  const applyBudgetExtension = useCallback(async (next: {
    schemaVersion: 1;
    maxAttempts: number;
    maxTotalTokens: number;
    maxTotalDurationMs: number;
    maxStagnantAttempts: number;
  }) => {
    if (!snapshot?.task.budget) return;
    const planVersion = meetingStore.getSnapshot().plan?.version;
    if (planVersion === undefined) {
      setBudgetExtensionError('当前计划版本不可用，请刷新后重试。');
      return;
    }
    const current = snapshot.task.budget;
    if (JSON.stringify(next) === JSON.stringify(current)) {
      setBudgetExtensionError('该任务已经是不设预算（上限已开满）。');
      return;
    }
    setBudgetExtensionError('');
    setExtendingBudget(true);
    try {
      const result = await window.vibeMeet.tasks.extendBudget(
        sessionId,
        taskId,
        planVersion,
        next,
      );
      if (!result.ok) {
        setBudgetExtensionError(result.error ?? '预算扩展失败');
        return;
      }
      const refreshed = await meetingStore.openTaskInspector(sessionId, taskId);
      if (!refreshed.ok) setBudgetExtensionError(refreshed.error);
    } catch (error) {
      setBudgetExtensionError(error instanceof Error ? error.message : '预算扩展失败');
    } finally {
      setExtendingBudget(false);
    }
  }, [sessionId, snapshot, taskId]);

  const extendBudget = useCallback(async () => {
    if (!snapshot?.task.budget) return;
    const current = snapshot.task.budget;
    const nextMaxAttempts = Math.min(100, current.maxAttempts + 1);
    await applyBudgetExtension({
      ...current,
      maxAttempts: nextMaxAttempts,
      maxTotalTokens: Math.min(
        100_000_000,
        current.maxTotalTokens + (snapshot.task.requestedProfile?.maxTokenBudget ?? 200_000),
      ),
      maxTotalDurationMs: Math.min(
        7 * 24 * 60 * 60 * 1_000,
        current.maxTotalDurationMs + (snapshot.task.requestedProfile?.timeoutMs ?? 1_800_000),
      ),
      maxStagnantAttempts: Math.min(
        20,
        nextMaxAttempts,
        current.maxStagnantAttempts + 1,
      ),
    });
  }, [applyBudgetExtension, snapshot]);

  /** Jump straight to schema ceilings so the paused task stops hitting budget. */
  const clearBudget = useCallback(async () => {
    if (!snapshot?.task.budget) return;
    await applyBudgetExtension({
      schemaVersion: 1,
      maxAttempts: 100,
      maxTotalTokens: 100_000_000,
      maxTotalDurationMs: 7 * 24 * 60 * 60 * 1_000,
      maxStagnantAttempts: 20,
    });
  }, [applyBudgetExtension, snapshot]);

  const resolveRecovery = useCallback(async (
    action:
      | 'continue-read-only'
      | 'continue-side-effecting'
      | 'retry-attempt'
      | 'resolve-integration-conflict'
      | 'abandon-task',
  ) => {
    setRecoveryError('');
    setResolvingRecovery(action);
    try {
      const result = await window.vibeMeet.sessions.resolveRecoveredTask(
        sessionId,
        taskId,
        action,
      );
      if (!result.ok) {
        setRecoveryError(result.error);
        return;
      }
      const refreshed = await meetingStore.openTaskInspector(sessionId, taskId);
      if (!refreshed.ok) setRecoveryError(refreshed.error);
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : '恢复失败');
    } finally {
      setResolvingRecovery('');
    }
  }, [sessionId, taskId]);

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
            {id === 'permissions' && (pendingPermission || pendingReviewEvidence.length > 0) && (
              <i aria-label="有待处理权限" />
            )}
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
            {snapshot.task.recovery && (
              <section className="task-diagnostic-list">
                <header>Crash recovery decision</header>
                <p>
                  <strong>{snapshot.task.recovery.classification}</strong>{' '}
                  {snapshot.task.recovery.reasonCode}
                </p>
                <p>
                  {snapshot.task.recovery.autoResume
                    ? '该任务具备显式只读权限，可自动续接；若自动续接失败，可在这里重试。'
                    : '在用户确认前不会向 Backend 发送 prompt，也不会重放命令、网络或外部副作用。'}
                </p>
                <div className="user-tasks-recovery-actions">
                  {snapshot.task.recovery.allowedActions.includes('continue-read-only') && (
                    <button
                      type="button"
                      disabled={Boolean(resolvingRecovery)}
                      onClick={() => void resolveRecovery('continue-read-only')}
                    >
                      继续只读任务
                    </button>
                  )}
                  {snapshot.task.recovery.allowedActions.includes('continue-side-effecting') && (
                    <button
                      type="button"
                      disabled={Boolean(resolvingRecovery)}
                      onClick={() => void resolveRecovery('continue-side-effecting')}
                    >
                      从现有 Attempt 继续
                    </button>
                  )}
                  {snapshot.task.recovery.allowedActions.includes('retry-attempt') && (
                    <button
                      type="button"
                      disabled={Boolean(resolvingRecovery)}
                      onClick={() => void resolveRecovery('retry-attempt')}
                    >
                      新建 Attempt 重跑
                    </button>
                  )}
                  {snapshot.task.recovery.allowedActions.includes('resolve-integration-conflict') && (
                    <button
                      type="button"
                      disabled={Boolean(resolvingRecovery)}
                      onClick={() => void resolveRecovery('resolve-integration-conflict')}
                    >
                      中止队列 Cherry-pick
                    </button>
                  )}
                  {snapshot.task.recovery.allowedActions.includes('abandon-task') && (
                    <button
                      type="button"
                      disabled={Boolean(resolvingRecovery)}
                      onClick={() => void resolveRecovery('abandon-task')}
                    >
                      放弃任务
                    </button>
                  )}
                </div>
                {recoveryError && (
                  <p className="task-inspector-error" role="alert">{recoveryError}</p>
                )}
              </section>
            )}
            {snapshot.task.budget && (
              <section className="task-diagnostic-list">
                <header>Bounded rework budget</header>
                <p>
                  <strong>Attempts</strong>{' '}
                  {snapshot.task.budgetState?.attempts ?? 0}/{snapshot.task.budget.maxAttempts}
                  {' · '}
                  <strong>Tokens</strong>{' '}
                  {(snapshot.task.budgetState?.totalTokens ?? 0).toLocaleString()}/
                  {snapshot.task.budget.maxTotalTokens.toLocaleString()}
                </p>
                <p>
                  <strong>Duration</strong>{' '}
                  {Math.round((snapshot.task.budgetState?.totalDurationMs ?? 0) / 60_000)} min/
                  {Math.round(snapshot.task.budget.maxTotalDurationMs / 60_000)} min
                  {' · '}
                  <strong>Stagnation</strong>{' '}
                  {snapshot.task.budgetState?.stagnantAttempts ?? 0}/
                  {snapshot.task.budget.maxStagnantAttempts}
                </p>
                {snapshot.task.status === 'budget-paused' && (
                  <>
                    <p>
                      {snapshot.task.budgetState?.reason === 'non-converging'
                        ? '连续返工未产生实质进展，需要你明确放开或加预算。'
                        : '已达到批准预算，需要你明确放开或加预算。'}
                    </p>
                    <div className="task-inspector-actions">
                      <button
                        type="button"
                        disabled={extendingBudget}
                        onClick={() => void clearBudget()}
                      >
                        {extendingBudget ? '正在记录决定…' : '不设预算并继续'}
                      </button>
                      <button
                        type="button"
                        disabled={extendingBudget}
                        onClick={() => void extendBudget()}
                      >
                        只加一次返工额度
                      </button>
                    </div>
                  </>
                )}
                {budgetExtensionError && (
                  <p className="task-inspector-error" role="alert">{budgetExtensionError}</p>
                )}
              </section>
            )}
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
          <div className="task-permission-stack">
            {pendingPermission && (
              <ApprovalCard
                pending={pendingPermission}
                owner={worker?.title ?? 'Worker'}
                backendId={worker?.backendId}
                project="当前项目"
                onDecide={onResolvePermission}
                resolving={worker?.resolvingPermissionId === pendingPermission.id}
                error={worker?.permissionError ?? null}
              />
            )}
            {stalledReview && (
              <section className="task-review-evidence-confirmation">
                <header>
                  <ShieldAlert size={18} />
                  <div>
                    <strong>Coordinator 审查未完成</strong>
                    <small>{stalledReview.pauseReason ?? 'user-required'}</small>
                  </div>
                </header>
                <p>
                  审查在覆盖全部分片前就停住了，交付没有通过，也不会自动通过。
                  还有 {stalledReview.uncoveredChunkIds.length} 个分片没有结论：
                  {stalledReview.uncoveredChunkIds.join('、') || '未知'}。
                </p>
                <button
                  type="button"
                  disabled={resumingReview}
                  onClick={() => void resumeReview(stalledReview.reviewId)}
                >
                  {resumingReview ? '正在恢复…' : '让 Coordinator 继续审查'}
                </button>
              </section>
            )}
            {pendingReviewEvidence.map((evidence) => (
              <section className="task-review-evidence-confirmation" key={evidence.chunkId}>
                <header>
                  <ShieldAlert size={18} />
                  <div>
                    <strong>需要人工检查的审查证据</strong>
                    <small>{evidence.kind} · {evidence.byteLength.toLocaleString()} bytes</small>
                  </div>
                </header>
                <code>{evidence.path}</code>
                <p>
                  该内容不会发送给 Coordinator 模型。请先在本机检查原始文件，
                  再确认与哈希绑定的证据已人工验收。
                </p>
                <small className="task-review-evidence-hash">
                  SHA-256 {evidence.chunkHash}
                </small>
                <button
                  type="button"
                  disabled={confirmingChunkId === evidence.chunkId}
                  onClick={() => void confirmReviewEvidence(
                    snapshot.reviewEvidence!.reviewId,
                    evidence.chunkId,
                    evidence.chunkHash,
                  )}
                >
                  {confirmingChunkId === evidence.chunkId ? '正在记录…' : '确认已人工检查'}
                </button>
              </section>
            ))}
            {reviewConfirmationError && (
              <div className="task-inspector-error" role="alert">{reviewConfirmationError}</div>
            )}
            {!pendingPermission && !stalledReview && pendingReviewEvidence.length === 0 && (
            <div className="task-permission-clear">
              <CheckCircle2 size={24} />
              <strong>没有待处理权限</strong>
              <p>计划范围内的低风险操作由 Coordinator 自动批准；高风险操作始终在这里确认。</p>
            </div>
            )}
          </div>
        )}
        {snapshot && activeTab === 'integration' && (
          <TaskReviewPanel snapshot={snapshot} mode="integration" />
        )}
      </div>
    </aside>
  );
}
