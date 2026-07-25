import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Eye,
  GitMerge,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import type { AggregatedTask, CrossProjectTasks } from '../lib/meeting-store';
import { dependencyGateShortLabel } from '../lib/dependency-gate';
import { TASK_COLUMNS, type TaskColumnId } from '../lib/task-columns';
import { useObservedTasks } from '../hooks/useObservedTasks';
import type {
  ObservedClientKind,
  ObservedSession,
  ObservedState,
} from '../lib/observed-store';
import type { WorkerStatus } from '../types';

interface TasksViewProps {
  data: CrossProjectTasks;
  /** Focus the owning project and drop the user into its meeting view. */
  onOpenTask: (sessionId: string, taskId: string) => void;
  /** Focus the owning project so its plan-approval modal comes up. */
  onOpenPlan: (sessionId: string) => void;
}

const ALL = '__all__';

function StatusIcon({ status, blocked }: { status: WorkerStatus; blocked: boolean }) {
  if (blocked) return <ShieldAlert size={13} />;
  if (status === 'accepted' || status === 'done') return <CheckCircle2 size={13} />;
  if (status === 'failed' || status === 'integration-conflict') return <AlertTriangle size={13} />;
  if (status === 'reworking') return <RotateCcw size={13} />;
  if (status === 'budget-paused' || status === 'interrupted') return <Clock3 size={13} />;
  if (
    status === 'reviewing'
    || status === 'coordinator-reviewing'
    || status === 'awaiting-acceptance'
    || status === 'integration-queued'
  ) return <GitMerge size={13} />;
  if (status === 'running' || status === 'verifying' || status === 'integrating') {
    return <LoaderCircle size={13} />;
  }
  return <CircleDashed size={13} />;
}

function TaskCard({ task, onOpen }: { task: AggregatedTask; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`tasks-card is-${task.status}${task.blockedReason ? ' is-blocked' : ''}`}
      onClick={onOpen}
      title={task.blockedReason ?? task.cwd}
    >
      <span className="tasks-card-project">{task.projectName}</span>
      <strong className="tasks-card-title">{task.title}</strong>
      <span className="tasks-card-meta">
        <StatusIcon status={task.status} blocked={Boolean(task.blockedReason)} />
        {task.blockedReason ?? task.statusLabel}
      </span>
      <span className="tasks-card-foot">
        <em>{task.backendId ?? 'Backend 待定'}</em>
        <em className={`tasks-card-gate is-${task.dependencyGate}`}>
          {dependencyGateShortLabel(task.dependencyGate)}
        </em>
        {task.attempt > 1 && <em>Attempt {task.attempt}</em>}
        {task.deps.length > 0 && <em>依赖 {task.deps.length}</em>}
      </span>
    </button>
  );
}

// ---- Observed sessions (S0 observation layer) -------------------------------

export const OBSERVED_STATE_LABEL: Record<ObservedState, string> = {
  active: '进行中',
  waiting: '等待输入',
  idle: '空闲',
  done: '已完成',
  unknown: '状态未知',
};

export const OBSERVED_CLIENT_LABEL: Record<ObservedClientKind, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
};

/** A done session leaves the board once it falls outside this window — the
 *  board is action-oriented; stale file-only history is S1 material. */
const RECENTLY_DONE_WINDOW_MS = 30 * 60_000;

/** Board column for an observed session, or null when it shouldn't render.
 *  `unknown` (file-only, no process) never shows. `idle` shows only when the
 *  row is backed by a live process (session.pid set) — the Codex Desktop
 *  host-backed idle ("window open, nothing running"); stale file-only CLI
 *  idle stays hidden (history surface, S1). `done` only while recent. */
export function columnForObserved(session: ObservedSession, now: number): TaskColumnId | null {
  switch (session.state) {
    case 'waiting':
      return 'attention';
    case 'active':
      return 'active';
    case 'idle':
      return session.pid !== undefined ? 'active' : null;
    case 'done':
      return now - session.lastActiveAt <= RECENTLY_DONE_WINDOW_MS ? 'settled' : null;
    default:
      return null;
  }
}

export function formatObservedAge(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return '刚刚活跃';
  if (min < 60) return `${min} 分钟前活跃`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前活跃`;
  return `${Math.floor(hr / 24)} 天前活跃`;
}

/** Read-only card for an externally-launched CLI session. Deliberately NOT an
 *  AggregatedTask: observed sessions have no attempt/deps/delivery semantics,
 *  and S0 offers no in-app action — just a pointer back to the client. */
function ObservedTaskCard({ session }: { session: ObservedSession }) {
  return (
    <div
      className={`tasks-card tasks-card-observed is-observed-${session.state}`}
      title={session.cwd}
    >
      <span className="tasks-card-project">{session.projectName}</span>
      <strong className="tasks-card-title">{session.title}</strong>
      <span className="tasks-card-meta">
        <Eye size={13} />
        {OBSERVED_STATE_LABEL[session.state]}
        <em className="tasks-card-inferred">推断</em>
        · {formatObservedAge(session.lastActiveAt)}
      </span>
      <span className="tasks-card-foot">
        <em className={`tasks-client-chip is-${session.clientKind}`}>
          {OBSERVED_CLIENT_LABEL[session.clientKind]}
        </em>
        {session.model && <em>{session.model}</em>}
        <em className="tasks-observed-badge">观察中</em>
      </span>
      <span className="tasks-card-actions">
        <button
          type="button"
          className="tasks-observed-action"
          disabled
          title="S0 仅观察：请切换到对应客户端处理"
        >
          去对应客户端处理 ↗
        </button>
      </span>
    </div>
  );
}

/** Cross-project task board. Reads the aggregated projection rather than any
 *  single session, so the user sees one meeting's worth of work even though
 *  each project still runs its own Orchestrator underneath. Observed sessions
 *  (external CLI windows) mix into the same columns after orchestrated cards. */
export function TasksView({ data, onOpenTask, onOpenPlan }: TasksViewProps) {
  const [projectFilter, setProjectFilter] = useState<string>(ALL);
  const [backendFilter, setBackendFilter] = useState<string>(ALL);
  const [noiseOpen, setNoiseOpen] = useState<Partial<Record<TaskColumnId, boolean>>>({});
  const observed = useObservedTasks();

  // Column-visible observed rows (unknown state and stale done are dropped),
  // sorted by lastActiveAt desc so they append after orchestrated cards.
  const boardableObserved = useMemo(() => {
    const now = Date.now();
    const rows: Array<{ session: ObservedSession; column: TaskColumnId }> = [];
    for (const session of observed.sessions) {
      const column = columnForObserved(session, now);
      if (column) rows.push({ session, column });
    }
    rows.sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt);
    return rows;
  }, [observed]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of data.tasks) seen.set(t.cwd, t.projectName);
    for (const p of data.pendingPlans) seen.set(p.cwd, p.projectName);
    // Projects with ONLY observed sessions still get a filter chip.
    for (const { session } of boardableObserved) {
      if (!seen.has(session.cwd)) seen.set(session.cwd, session.projectName);
    }
    return [...seen.entries()].map(([cwd, name]) => ({ cwd, name }));
  }, [data, boardableObserved]);

  const backends = useMemo(() => {
    const seen = new Set<string>();
    for (const t of data.tasks) if (t.backendId) seen.add(t.backendId);
    // clientKind shares the backendId vocabulary (claude-code / codex).
    for (const { session } of boardableObserved) seen.add(session.clientKind);
    return [...seen].sort();
  }, [data.tasks, boardableObserved]);

  const visible = useMemo(() => data.tasks.filter((t) => (
    (projectFilter === ALL || t.cwd === projectFilter)
    && (backendFilter === ALL || t.backendId === backendFilter)
  )), [data.tasks, projectFilter, backendFilter]);

  const visibleObserved = useMemo(() => boardableObserved.filter(({ session }) => (
    (projectFilter === ALL || session.cwd === projectFilter)
    && (backendFilter === ALL || session.clientKind === backendFilter)
  )), [boardableObserved, projectFilter, backendFilter]);

  const visiblePlans = data.pendingPlans.filter(
    (p) => projectFilter === ALL || p.cwd === projectFilter,
  );

  const byColumn = useMemo(() => {
    const map = new Map<TaskColumnId, AggregatedTask[]>(
      TASK_COLUMNS.map((c) => [c.id, [] as AggregatedTask[]]),
    );
    for (const task of visible) map.get(task.column)?.push(task);
    return map;
  }, [visible]);

  const observedByColumn = useMemo(() => {
    const map = new Map<TaskColumnId, { normal: ObservedSession[]; noise: ObservedSession[] }>(
      TASK_COLUMNS.map((c) => [c.id, { normal: [], noise: [] }]),
    );
    for (const row of visibleObserved) {
      const bucket = map.get(row.column);
      if (!bucket) continue;
      (row.session.isNoise ? bucket.noise : bucket.normal).push(row.session);
    }
    return map;
  }, [visibleObserved]);

  const observedNormalCount = visibleObserved.reduce(
    (sum, row) => sum + (row.session.isNoise ? 0 : 1),
    0,
  );
  const total = visible.length + visiblePlans.length + observedNormalCount;

  return (
    <main className="tasks-view">
      <header className="tasks-toolbar">
        <div className="tasks-toolbar-lead">
          <strong>任务</strong>
          <span>{total} 项 · {projects.length} 个项目</span>
        </div>
        <div className="tasks-filters">
          <label className="tasks-filter">
            <span>项目</span>
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              <option value={ALL}>全部项目</option>
              {projects.map((p) => (
                <option key={p.cwd} value={p.cwd}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="tasks-filter">
            <span>客户端</span>
            <select value={backendFilter} onChange={(e) => setBackendFilter(e.target.value)}>
              <option value={ALL}>全部客户端</option>
              {backends.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="tasks-board">
        {TASK_COLUMNS.map((column) => {
          const items = byColumn.get(column.id) ?? [];
          const plans = column.id === 'attention' ? visiblePlans : [];
          const observedBucket = observedByColumn.get(column.id) ?? { normal: [], noise: [] };
          const count = items.length + plans.length + observedBucket.normal.length;
          const isNoiseOpen = Boolean(noiseOpen[column.id]);
          return (
            <section className={`tasks-column tasks-column-${column.id}`} key={column.id}>
              <header className="tasks-column-head">
                <div>
                  <strong>{column.title}</strong>
                  <small>{column.hint}</small>
                </div>
                <span className="tasks-column-count">{count}</span>
              </header>
              <div className="tasks-column-scroll">
                {plans.map((plan) => (
                  <button
                    type="button"
                    key={`plan:${plan.sessionId}`}
                    className="tasks-card is-plan"
                    onClick={() => onOpenPlan(plan.sessionId)}
                    title={plan.cwd}
                  >
                    <span className="tasks-card-project">{plan.projectName}</span>
                    <strong className="tasks-card-title">计划待批准</strong>
                    <span className="tasks-card-meta">
                      <ShieldAlert size={13} />
                      {plan.taskCount} 个任务等待你确认
                    </span>
                  </button>
                ))}
                {items.map((task) => (
                  <TaskCard
                    key={task.key}
                    task={task}
                    onOpen={() => onOpenTask(task.sessionId, task.taskId)}
                  />
                ))}
                {observedBucket.normal.map((session) => (
                  <ObservedTaskCard key={`obs:${session.id}`} session={session} />
                ))}
                {observedBucket.noise.length > 0 && (
                  <div className="tasks-noise-group">
                    <button
                      type="button"
                      className="tasks-noise-toggle"
                      onClick={() => setNoiseOpen((prev) => ({
                        ...prev,
                        [column.id]: !prev[column.id],
                      }))}
                    >
                      {isNoiseOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      噪声 · {observedBucket.noise.length}
                    </button>
                    {isNoiseOpen && observedBucket.noise.map((session) => (
                      <ObservedTaskCard key={`obs:${session.id}`} session={session} />
                    ))}
                  </div>
                )}
                {count === 0 && observedBucket.noise.length === 0 && (
                  <p className="tasks-column-empty">暂无</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
