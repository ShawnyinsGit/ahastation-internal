import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  GitMerge,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
} from 'lucide-react';
import type { AggregatedTask, CrossProjectTasks } from '../lib/meeting-store';
import { TASK_COLUMNS, type TaskColumnId } from '../lib/task-columns';
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
        {task.attempt > 1 && <em>Attempt {task.attempt}</em>}
        {task.deps.length > 0 && <em>依赖 {task.deps.length}</em>}
      </span>
    </button>
  );
}

/** Cross-project task board. Reads the aggregated projection rather than any
 *  single session, so the user sees one meeting's worth of work even though
 *  each project still runs its own Orchestrator underneath. */
export function TasksView({ data, onOpenTask, onOpenPlan }: TasksViewProps) {
  const [projectFilter, setProjectFilter] = useState<string>(ALL);
  const [backendFilter, setBackendFilter] = useState<string>(ALL);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of data.tasks) seen.set(t.cwd, t.projectName);
    for (const p of data.pendingPlans) seen.set(p.cwd, p.projectName);
    return [...seen.entries()].map(([cwd, name]) => ({ cwd, name }));
  }, [data]);

  const backends = useMemo(() => {
    const seen = new Set<string>();
    for (const t of data.tasks) if (t.backendId) seen.add(t.backendId);
    return [...seen].sort();
  }, [data.tasks]);

  const visible = useMemo(() => data.tasks.filter((t) => (
    (projectFilter === ALL || t.cwd === projectFilter)
    && (backendFilter === ALL || t.backendId === backendFilter)
  )), [data.tasks, projectFilter, backendFilter]);

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

  const total = visible.length + visiblePlans.length;

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
          const count = items.length + plans.length;
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
                {count === 0 && <p className="tasks-column-empty">暂无</p>}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
