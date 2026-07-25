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
import type { WorkerState } from '../lib/meeting-store';
import { WORKER_STATUS_LABEL as LABEL } from '../lib/task-columns';
import type { MeetingPlan, WorkerStatus } from '../types';

interface TaskRailProps {
  plan: MeetingPlan | null;
  workers: WorkerState[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const PROGRESS: Record<WorkerStatus, number> = {
  pending: 0,
  running: 34,
  verifying: 58,
  reviewing: 72,
  'awaiting-acceptance': 84,
  'integration-queued': 88,
  integrating: 94,
  'integration-conflict': 94,
  reworking: 48,
  'budget-paused': 48,
  accepted: 100,
  interrupted: 45,
  done: 100,
  failed: 100,
};

function StatusIcon({ status, attention }: { status: WorkerStatus; attention: boolean }) {
  if (attention) return <ShieldAlert size={14} />;
  if (status === 'accepted' || status === 'done') return <CheckCircle2 size={14} />;
  if (status === 'failed' || status === 'integration-conflict') return <AlertTriangle size={14} />;
  if (status === 'reworking') return <RotateCcw size={14} />;
  if (status === 'budget-paused') return <Clock3 size={14} />;
  if (
    status === 'reviewing'
    || status === 'awaiting-acceptance'
    || status === 'integration-queued'
  ) return <GitMerge size={14} />;
  if (status === 'running' || status === 'verifying' || status === 'integrating') {
    return <LoaderCircle size={14} />;
  }
  if (status === 'interrupted') return <Clock3 size={14} />;
  return <CircleDashed size={14} />;
}

export function TaskRail({ plan, workers, selectedId, onSelect }: TaskRailProps) {
  const nodes = plan?.nodes ?? [];
  if (nodes.length === 0) return null;
  const statuses = new Map(nodes.map((node) => [node.id, node.status]));
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));

  return (
    <nav className="task-rail" aria-label="任务执行轨道">
      <header className="task-rail-header">
        <div>
          <span>任务轨道</span>
          <strong>{nodes.length} Tasks</strong>
        </div>
        <small>{nodes.filter((node) => node.status === 'accepted' || node.status === 'done').length}/{nodes.length}</small>
      </header>
      <div className="task-rail-scroll">
        {nodes.map((node, index) => {
          const worker = workerById.get(node.id);
          const blockedByDependency = node.status === 'pending'
            && node.deps.some((dep) => statuses.get(dep) !== 'accepted');
          const label = worker?.pendingPermission
            ? '等待权限'
            : node.workspaceDiagnostic
              ? '工作区待处理'
            : blockedByDependency
              ? '等待依赖'
              : node.status === 'pending'
                ? '等待执行名额'
                : LABEL[node.status];
          return (
            <div className="task-rail-step" key={node.id}>
              {index > 0 && <span className="task-rail-connector" aria-hidden />}
              <button
                type="button"
                className={`task-rail-node is-${node.status}${selectedId === node.id ? ' is-selected' : ''}`}
                onClick={() => onSelect(node.id)}
                aria-label={`${node.title}，${label}`}
                aria-pressed={selectedId === node.id}
                title={node.workspaceDiagnostic?.message}
              >
                <span className="task-rail-index">{index + 1}</span>
                <span className="task-rail-copy">
                  <strong>{node.title}</strong>
                  <span className="task-rail-backend">
                    {worker?.backendId ?? node.executorBackendId ?? 'Backend 待定'}
                    <em>Attempt {worker?.attempt ?? 1}</em>
                  </span>
                  <small>
                    <StatusIcon status={node.status} attention={Boolean(worker?.pendingPermission)} />
                    {label}
                  </small>
                  {node.deps.length > 0 && (
                    <span className="task-rail-deps">依赖 {node.deps.join(', ')}</span>
                  )}
                  <span className="task-rail-progress" aria-label={`${label} ${PROGRESS[node.status]}%`}>
                    <i style={{ width: `${PROGRESS[node.status]}%` }} />
                  </span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
