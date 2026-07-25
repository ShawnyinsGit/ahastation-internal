import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import type {
  ActivityEntry,
  CoordinatorBriefing,
  TranscriptEntry,
  WorkerSpecialty,
  WorkerStatus,
  WorkerTaskHistoryEntry,
  WorkerEventV2,
  WorkReport,
} from '../types';
import type { DeliverySnapshot } from '../lib/meeting-store';
import { BackendAvatar } from './BackendAvatar';

type CurrentTaskStatus = 'idle' | WorkerStatus | 'speaking';

interface ClaudeWorkspaceProps {
  speaking: boolean;
  awaitingPermission: boolean;
  running: boolean;
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  // Identity overrides used when this workspace is rendered for a specific
  // worker (dock view). Defaults preserve the original single-agent UI.
  name?: string;
  subtitle?: string;
  avatar?: 'claude' | 'worker';
  initial?: string;
  /** Backend icon identifier for per-backend avatar rendering. Overrides avatar prop for talkers. */
  iconId?: string;
  /** Custom avatar image URL (overrides iconId). */
  customAvatar?: string | null;
  // Gallery view shows identity in the top tile row, so the workspace's own
  // avatar/name/status header is redundant. Pass true to skip rendering it.
  hideHero?: boolean;
  // Current task title for the worker this workspace represents.
  //   undefined → hide the current-task card entirely (e.g. talker)
  //   null      → render "Idle" placeholder
  //   string    → render the task as a Current-action style card
  task?: string | null;
  taskStatus?: CurrentTaskStatus;
  taskSpecialty?: WorkerSpecialty;
  taskDeps?: string[];
  taskHistory?: WorkerTaskHistoryEntry[];
  currentTool?: string | null;
  currentToolInput?: string | null;
  lastText?: string;
  startedAt?: number | null;
  pendingPermissionTool?: string | null;
  backendId?: string;
  attempt?: number;
  workerEvents?: WorkerEventV2[];
  workReport?: WorkReport;
  coordinatorBriefings?: CoordinatorBriefing[];
  deliveryHistory?: DeliverySnapshot[];
  onAcceptDelivery?: () => void;
  onInterruptTask?: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onSteerTask?: (instruction: string) => Promise<{ ok: true; queued: boolean } | { ok: false; error: string }>;
  onOpenWorkspace?: () => Promise<{ ok: boolean; error?: string }>;
  onOpenInTerminal?: () => void;
  /** Whether this workspace represents a talker. */
  isTalker?: boolean;
  /** High-fidelity Bash/command log for the CLI execution view. */
  commandLog?: import('../types').CommandRun[];
}

const dotColor: Record<ActivityEntry['kind'], string> = {
  'tool-call': '#7cc6ff',
  'tool-result': '#9ae29a',
  system: '#c8c8c8',
  error: '#ff7a7a',
  document: '#5b8def',
};

const taskStatusTone: Record<CurrentTaskStatus, 'idle' | 'waiting' | 'working' | 'done' | 'failed' | 'speaking'> = {
  idle: 'idle',
  pending: 'waiting',
  interrupted: 'waiting',
  running: 'working',
  verifying: 'working',
  reviewing: 'working',
  'coordinator-reviewing': 'working',
  'awaiting-acceptance': 'waiting',
  'integration-queued': 'waiting',
  integrating: 'working',
  'integration-conflict': 'failed',
  reworking: 'working',
  'budget-paused': 'waiting',
  accepted: 'done',
  done: 'done',
  failed: 'failed',
  speaking: 'speaking',
};

const taskStatusLabel: Record<CurrentTaskStatus, string> = {
  idle: '空闲',
  pending: '等待调度',
  interrupted: '已中断',
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
  done: '已完成',
  failed: '失败',
  speaking: '发言中',
};

function statusFor(speaking: boolean, awaitingPermission: boolean, running: boolean, hasRecentTool: boolean): { label: string; tone: 'speaking' | 'working' | 'waiting' | 'idle' | 'off' } {
  if (!running) return { label: '离线', tone: 'off' };
  if (awaitingPermission) return { label: '等待权限', tone: 'waiting' };
  if (speaking) return { label: '发言中', tone: 'speaking' };
  if (hasRecentTool) return { label: '执行中', tone: 'working' };
  return { label: '倾听中', tone: 'idle' };
}

function formatHistoryTime(ts: number): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

function formatDuration(start: number | null | undefined, end: number): string {
  if (!start || !end || end < start) return '';
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

interface FeedRow {
  key: string;
  kind: 'task-history' | ActivityEntry['kind'];
  dotColor: string;
  ts: number;
  title: string;
  detail?: string;
  pill?: { label: string; tone: 'done' | 'failed' | 'running' | 'pending' };
  activityId?: string;
}

export const ClaudeWorkspace = memo(function ClaudeWorkspace({
  speaking,
  awaitingPermission,
  running,
  transcript,
  activity,
  name = 'Claude',
  subtitle,
  avatar = 'claude',
  initial,
  iconId,
  customAvatar,
  hideHero = false,
  task,
  taskStatus,
  taskSpecialty,
  taskDeps,
  taskHistory,
  currentTool,
  currentToolInput,
  lastText,
  startedAt,
  pendingPermissionTool,
  backendId,
  attempt,
  workerEvents,
  workReport,
  coordinatorBriefings,
  deliveryHistory,
  onAcceptDelivery,
  onInterruptTask,
  onSteerTask,
  onOpenWorkspace,
  onOpenInTerminal,
  isTalker,
  commandLog,
}: ClaudeWorkspaceProps) {
  const lastAssistant = useMemo(() => [...transcript].reverse().find((t) => t.role === 'assistant'), [transcript]);
  const latestToolCall = useMemo(
    () => [...activity].reverse().find((a) => a.kind === 'tool-call'),
    [activity],
  );

  // The "Working" pill expires 8s after the last tool call. Date.now() in
  // render alone won't re-evaluate without a new prop/state change, so we
  // tick a clock every second while a recent tool call exists.
  const [, setClockTick] = useState(0);
  const toolTs = latestToolCall?.ts ?? 0;
  useEffect(() => {
    if (!toolTs) return;
    const stillRecent = () => Date.now() - toolTs < 8000;
    if (!stillRecent()) return;
    const id = setInterval(() => {
      if (stillRecent()) {
        setClockTick((n) => n + 1);
      } else {
        clearInterval(id);
        setClockTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [toolTs]);

  const status = statusFor(speaking, awaitingPermission, running, Boolean(latestToolCall) && (Date.now() - toolTs < 8000));

  // Per-row expand/collapse for the current task card and each feed row.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [instruction, setInstruction] = useState('');
  const [taskAction, setTaskAction] = useState<{ pending: boolean; message: string }>({
    pending: false,
    message: '',
  });
  const toggleExpand = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Current task — only rendered when task !== undefined.
  const showCurrentTask = task !== undefined;
  const currentTaskTone = taskStatus ? taskStatusTone[taskStatus] : 'idle';
  const currentTaskLabel = taskStatus ? taskStatusLabel[taskStatus] : 'Idle';
  const currentTaskExpanded = expanded.has('__current__');

  const deliveryLen = deliveryHistory?.length ?? 0;
  const prevDeliveryLen = useRef(deliveryLen);
  useEffect(() => {
    if (!deliveryHistory || deliveryHistory.length === 0) return;
    if (deliveryHistory.length <= prevDeliveryLen.current) {
      prevDeliveryLen.current = deliveryHistory.length;
      return;
    }
    prevDeliveryLen.current = deliveryHistory.length;
    const latest = deliveryHistory[deliveryHistory.length - 1];
    const key = `delivery-${latest.taskId}`;
    setExpanded((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, [deliveryLen, deliveryHistory]);

  // Build the merged feed: taskHistory (most recent first) followed by
  // recent activity entries. Capped so we don't blow the panel up.
  const feedRows: FeedRow[] = useMemo(() => {
    const rows: FeedRow[] = [];
    if (taskHistory && taskHistory.length > 0) {
      for (const entry of [...taskHistory].reverse()) {
        rows.push({
          key: `task-${entry.id}`,
          kind: 'task-history',
          dotColor: entry.status === 'failed' ? '#ff7a7a' : entry.status === 'done' ? '#9ae29a' : '#7cc6ff',
          ts: entry.finishedAt || entry.startedAt,
          title: entry.title,
          detail: entry.summary,
          pill: {
            label: entry.status,
            tone: entry.status === 'done' || entry.status === 'failed' || entry.status === 'running' || entry.status === 'pending'
              ? entry.status
              : 'pending',
          },
        });
      }
    }
    for (const a of activity.slice(-10).reverse()) {
      rows.push({
        key: `act-${a.id}`,
        kind: a.kind,
        dotColor: dotColor[a.kind],
        ts: a.ts,
        title: a.title,
        detail: a.detail,
        activityId: a.id,
      });
    }
    return rows.slice(0, 12);
  }, [taskHistory, activity]);

  return (
    <div className={`workspace workspace-${status.tone}`}>
      <div className="workspace-aurora" />

      {!hideHero && (
        <header className="workspace-hero">
          <div className="workspace-avatar">
            {avatar === 'claude' ? (
              <BackendAvatar iconId={iconId ?? 'claude'} size={104} speaking={speaking} customAvatar={customAvatar} />
            ) : (
              <div className="workspace-avatar-worker">
                <span className="workspace-avatar-worker-initial">
                  {(initial ?? name.trim().slice(0, 1) ?? '?').toUpperCase()}
                </span>
              </div>
            )}
            {(speaking || awaitingPermission) && <span className="workspace-avatar-ring" />}
          </div>
          <div className="workspace-hero-text">
            <div className="workspace-name" title={name}>{name}</div>
            {subtitle && <div className="workspace-subtitle">{subtitle}</div>}
            <div className={`workspace-status workspace-status-${status.tone}`}>
              <span className="workspace-status-dot" />
              {status.label}
            </div>
          </div>
        </header>
      )}

      {onOpenInTerminal && ((commandLog && commandLog.length > 0) || running || isTalker) && (
        <div className={`workspace-terminal-btn-row${hideHero ? ' workspace-terminal-btn-row--compact' : ''}`}>
          <button
            type="button"
            className="workspace-hero-terminal-btn"
            onClick={onOpenInTerminal}
            title="查看真实 CLI 执行情况"
            aria-label="Open CLI execution view"
          >
            <Terminal size={14} />
            <span className="workspace-terminal-btn-label">
              {backendId === 'codex'
                ? 'Codex CLI'
                : backendId === 'claude-code'
                  ? 'Claude CLI'
                  : 'Terminal'}
            </span>
          </button>
        </div>
      )}

      {showCurrentTask && (
        <section className="workspace-now workspace-current-task">
          <div className="workspace-now-label">Current task</div>
          <button
            type="button"
            className={`workspace-now-card workspace-task-card ${currentTaskExpanded ? 'workspace-task-card-open' : ''}`}
            onClick={() => toggleExpand('__current__')}
            aria-expanded={currentTaskExpanded}
            aria-label={task ? `Current task: ${task}` : 'No current task'}
          >
            <div className="workspace-task-row">
              <span className="workspace-task-caret" aria-hidden>
                {currentTaskExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </span>
              <span className="workspace-task-title" title={task ?? undefined}>
                {task ?? 'Idle'}
              </span>
              <span className={`workspace-task-pill workspace-task-pill-${currentTaskTone}`}>
                {currentTaskLabel}
              </span>
            </div>
            {currentTaskExpanded && (
              <div className="workspace-task-detail" onClick={(e) => e.stopPropagation()}>
                {currentTool && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Tool</span>
                    <span className="workspace-task-detail-value">
                      {currentTool}
                      {currentToolInput && <span className="workspace-task-detail-mono"> · {currentToolInput}</span>}
                    </span>
                  </div>
                )}
                {pendingPermissionTool && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Awaiting</span>
                    <span className="workspace-task-detail-value">{pendingPermissionTool}</span>
                  </div>
                )}
                {taskDeps && taskDeps.length > 0 && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Deps</span>
                    <span className="workspace-task-detail-value">{taskDeps.join(', ')}</span>
                  </div>
                )}
                {backendId && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Backend</span>
                    <span className="workspace-task-detail-value">{backendId}</span>
                  </div>
                )}
                {attempt && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Attempt</span>
                    <span className="workspace-task-detail-value">{attempt}</span>
                  </div>
                )}
                {startedAt && (
                  <div className="workspace-task-detail-row">
                    <span className="workspace-task-detail-label">Started</span>
                    <span className="workspace-task-detail-value">{formatHistoryTime(startedAt)}</span>
                  </div>
                )}
                {lastText && (
                  <div className="workspace-task-detail-row workspace-task-detail-row-block">
                    <span className="workspace-task-detail-label">Last said</span>
                    <span className="workspace-task-detail-value workspace-task-detail-text">{lastText}</span>
                  </div>
                )}
                {!currentTool && !pendingPermissionTool && !taskSpecialty && (!taskDeps || taskDeps.length === 0) && !startedAt && !lastText && (
                  <div className="workspace-task-detail-empty">No additional context yet.</div>
                )}
              </div>
            )}
          </button>
        </section>
      )}

      {workerEvents && workerEvents.length > 0 && (
        <section className="workspace-feed workspace-worker-events">
          <div className="workspace-feed-label">事件时间线</div>
          <ol className="worker-event-timeline">
            {[...workerEvents].slice(-30).reverse().map((event) => {
              const signal = event.payload;
              const title = signal.kind === 'progress'
                ? signal.message
                : signal.kind === 'tool'
                  ? `${signal.toolName} · ${signal.phase}`
                  : signal.kind === 'delivery'
                    ? 'WorkReport 已提交'
                    : signal.kind === 'failed'
                      ? `${signal.code} · ${signal.message}`
                      : `执行结束 · ${signal.reason}`;
              return (
                <li key={event.eventId}>
                  <span className={`worker-event-kind is-${signal.kind}`}>{signal.kind}</span>
                  <div>
                    <strong>{title}</strong>
                    <small>seq {event.seq} · attempt {event.attempt} · {formatHistoryTime(event.timestamp)}</small>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {showCurrentTask && (onInterruptTask || onSteerTask || onOpenWorkspace) && (
        <section className="task-inspector-actions" aria-label="任务操作">
          {onSteerTask && (
            <div className="task-inspector-steer">
              <label htmlFor={`worker-instruction-${name}`}>追加指令</label>
              <textarea
                id={`worker-instruction-${name}`}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
                placeholder="说明下一步、修正方向或约束…"
                disabled={taskAction.pending}
              />
              <button
                type="button"
                disabled={taskAction.pending || !instruction.trim()}
                onClick={() => {
                  const text = instruction.trim();
                  if (!text) return;
                  setTaskAction({ pending: true, message: '' });
                  void onSteerTask(text).then((result) => {
                    if (result.ok) {
                      setInstruction('');
                      setTaskAction({
                        pending: false,
                        message: result.queued ? '指令已排队，等待 Worker 就绪。' : '指令已发送。',
                      });
                    } else {
                      setTaskAction({ pending: false, message: result.error });
                    }
                  });
                }}
              >
                发送指令
              </button>
            </div>
          )}
          <div className="task-inspector-action-row">
            {onInterruptTask && (
              <button
                type="button"
                className="is-danger"
                disabled={taskAction.pending}
                onClick={() => {
                  setTaskAction({ pending: true, message: '' });
                  void onInterruptTask().then((result) => {
                    setTaskAction({
                      pending: false,
                      message: result.ok ? '中断请求已确认。' : result.error,
                    });
                  });
                }}
              >
                中断 Worker
              </button>
            )}
            {onOpenWorkspace && (
              <button
                type="button"
                disabled={taskAction.pending}
                onClick={() => {
                  setTaskAction({ pending: true, message: '' });
                  void onOpenWorkspace().then((result) => {
                    setTaskAction({
                      pending: false,
                      message: result.ok ? '已打开工作区。' : (result.error ?? '无法打开工作区。'),
                    });
                  });
                }}
              >
                打开工作区
              </button>
            )}
          </div>
          {taskAction.message && <p role="status">{taskAction.message}</p>}
        </section>
      )}

      {workReport && (
        <section className="workspace-feed workspace-work-report">
          <div className="workspace-feed-label">WorkReport</div>
          <div className="workspace-report-card">
            <div><strong>{workReport.status}</strong><span>{workReport.summary}</span></div>
            <small>
              {workReport.files.length} files · {workReport.tests.length} tests · {workReport.unresolved.length} unresolved
            </small>
          </div>
        </section>
      )}

      {coordinatorBriefings && coordinatorBriefings.length > 0 && (
        <section className="workspace-feed coordinator-briefings" aria-live="polite">
          <div className="workspace-feed-label">结构化 Briefing</div>
          <div className="coordinator-briefing-list">
            {[...coordinatorBriefings].slice(-6).reverse().map((briefing) => (
              <article className={`coordinator-briefing-card is-${briefing.kind}`} key={briefing.id}>
                <header>
                  <strong>{briefing.title}</strong>
                  <time>{formatHistoryTime(briefing.timestamp)}</time>
                </header>
                <p>{briefing.summary}</p>
                <dl>
                  <div><dt>已接受</dt><dd>{briefing.completedTasks}</dd></div>
                  <div><dt>失败</dt><dd>{briefing.failedTasks}</dd></div>
                  <div><dt>文件</dt><dd>{briefing.files}</dd></div>
                  <div><dt>测试</dt><dd>{briefing.testsPassed} / {briefing.testsFailed}</dd></div>
                </dl>
                {briefing.capacity && (
                  <p className="coordinator-briefing-capacity">
                    容量 {briefing.capacity.running}/{briefing.capacity.limit} · 等待 {briefing.capacity.waiting}
                  </p>
                )}
                {briefing.blockers.length > 0 && (
                  <ul>{briefing.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
                )}
                <footer>建议：{briefing.recommendedAction}</footer>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* Keep the original "Latest thought" surface when there's no active tool;
          omit it for talker once a current-task card is in play to avoid stacking. */}
      {lastAssistant && !latestToolCall && !showCurrentTask && (
        <section className="workspace-now">
          <div className="workspace-now-label">Latest thought</div>
          <div className="workspace-now-card workspace-now-thought">
            {lastAssistant.text.slice(0, 280)}
            {lastAssistant.text.length > 280 ? '…' : ''}
          </div>
        </section>
      )}

      {deliveryHistory && deliveryHistory.length > 0 && (
        <section className="workspace-feed">
          <div className="workspace-feed-label">Deliveries</div>
          <div className="workspace-feed-list">
            {[...deliveryHistory].reverse().map((d) => {
              const key = `delivery-${d.taskId}`;
              const isOpen = expanded.has(key);
              const isPending = d.status === 'awaiting-delivery-acceptance';
              const isReworking = d.status === 'reworking';
              const isIntegrating = d.status === 'integration-queued' || d.status === 'integrating';
              const isConflict = d.status === 'integration-conflict';
              const statusPill = d.status === 'accepted'
                ? 'done'
                : isReworking || isIntegrating
                  ? 'working'
                  : 'pending';
              const statusLabel = d.status === 'accepted'
                ? 'Accepted'
                : isReworking
                  ? 'Needs rework'
                  : isConflict
                    ? 'Integration conflict'
                    : d.status === 'integration-queued'
                      ? 'Queued for integration'
                      : d.status === 'integrating'
                        ? 'Integrating'
                  : d.status === 'verifying'
                    ? 'Verifying'
                    : d.status === 'reviewing'
                      ? 'Reviewing'
                      : `${d.files.length} files`;
              return (
                <div
                  key={key}
                  className={`workspace-feed-row workspace-feed-row-clickable ${isOpen ? 'workspace-feed-row-open' : ''}`}
                  onClick={() => toggleExpand(key)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(key);
                    }
                  }}
                  aria-expanded={isOpen}
                >
                  <span
                    className="workspace-feed-dot"
                    style={{
                      background: d.status === 'accepted'
                        ? '#9ae29a'
                        : isReworking || isConflict
                          ? '#f5c542'
                          : '#7cc6ff',
                    }}
                  />
                  <div className="workspace-feed-text">
                    <div className="workspace-feed-title">
                      <span className="workspace-feed-title-text">{d.title}</span>
                      <span className={`workspace-task-pill workspace-task-pill-${statusPill}`}>
                        {statusLabel}
                      </span>
                      {d.receivedAt > 0 && (
                        <span className="workspace-feed-time">{formatHistoryTime(d.receivedAt)}</span>
                      )}
                      <span className="workspace-feed-caret" aria-hidden>
                        {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </span>
                    </div>
                    {!isOpen && d.summary && (
                      <div className="workspace-feed-detail">{d.summary}</div>
                    )}
                    {isOpen && (
                      <div className="workspace-feed-detail workspace-feed-detail-expanded">
                        {d.summary}
                        {isPending && onAcceptDelivery && (
                          <button
                            type="button"
                            className="workspace-delivery-accept-btn"
                            onClick={(e) => { e.stopPropagation(); onAcceptDelivery(); }}
                          >
                            通过
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="workspace-feed">
        <div className="workspace-feed-label">Recent activity</div>
        <div className="workspace-feed-list">
          {feedRows.length === 0 ? (
            <div className="workspace-feed-empty">No activity yet.</div>
          ) : (
            feedRows.map((row) => {
              const isOpen = expanded.has(row.key);
              const clickable = Boolean(row.detail);
              return (
                <div
                  key={row.key}
                  className={`workspace-feed-row ${clickable ? 'workspace-feed-row-clickable' : ''} ${isOpen ? 'workspace-feed-row-open' : ''}`}
                  onClick={clickable ? () => toggleExpand(row.key) : undefined}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onKeyDown={clickable ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleExpand(row.key);
                    }
                  } : undefined}
                  aria-expanded={clickable ? isOpen : undefined}
                >
                  <span className="workspace-feed-dot" style={{ background: row.dotColor }} />
                  <div className="workspace-feed-text">
                    <div className="workspace-feed-title">
                      {row.kind === 'task-history' && (
                        <span className={`workspace-feed-task-pill workspace-feed-task-pill-${row.pill?.tone ?? 'pending'}`}>
                          Task
                        </span>
                      )}
                      <span className="workspace-feed-title-text">{row.title}</span>
                      {row.pill && (
                        <span className={`workspace-task-pill workspace-task-pill-${row.pill.tone === 'done' ? 'done' : row.pill.tone === 'failed' ? 'failed' : row.pill.tone === 'running' ? 'working' : 'waiting'}`}>
                          {row.pill.label}
                        </span>
                      )}
                      {row.ts > 0 && (
                        <span className="workspace-feed-time">{formatHistoryTime(row.ts)}</span>
                      )}
                      {row.kind === 'tool-call' && row.title.toLowerCase().includes('bash') && onOpenInTerminal && (
                        <button
                          type="button"
                          className="workspace-feed-terminal-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenInTerminal();
                          }}
                          title="Open in terminal tab"
                        >
                          <Terminal size={12} />
                        </button>
                      )}
                      {clickable && (
                        <span className="workspace-feed-caret" aria-hidden>
                          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                      )}
                    </div>
                    {row.detail && !isOpen && (
                      <div className="workspace-feed-detail">{row.detail}</div>
                    )}
                    {row.detail && isOpen && (
                      <div className="workspace-feed-detail workspace-feed-detail-expanded">
                        {row.detail}
                        {row.kind === 'task-history' && (
                          <div className="workspace-feed-meta">
                            duration {formatDuration((taskHistory ?? []).find((h) => `task-${h.id}` === row.key)?.startedAt ?? null, row.ts)}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
});
