import type { WorkerState } from '../lib/meeting-store';
import type { MeetingPlan, WorkerStatus } from '../types';

interface TaskRailProps {
  plan: MeetingPlan | null;
  workers: WorkerState[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const LABEL: Record<WorkerStatus, string> = {
  pending: '等待调度',
  running: '执行中',
  verifying: '校验中',
  reviewing: '评审中',
  'awaiting-acceptance': '等待验收',
  reworking: '需要返工',
  accepted: '已接受',
  interrupted: '已中断',
  done: '已完成',
  failed: '失败',
};

export function TaskRail({ plan, workers, selectedId, onSelect }: TaskRailProps) {
  const nodes = plan?.nodes ?? [];
  if (nodes.length === 0) return null;
  const statuses = new Map(nodes.map((node) => [node.id, node.status]));
  const workerById = new Map(workers.map((worker) => [worker.id, worker]));

  return (
    <nav className="task-rail" aria-label="任务执行轨道">
      <div className="task-rail-label">任务</div>
      <div className="task-rail-scroll">
        {nodes.map((node, index) => {
          const worker = workerById.get(node.id);
          const blockedByDependency = node.status === 'pending'
            && node.deps.some((dep) => statuses.get(dep) !== 'accepted');
          const label = worker?.pendingPermission
            ? '等待权限'
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
              >
                <span className="task-rail-dot" />
                <span className="task-rail-copy">
                  <strong>{node.title}</strong>
                  <small>
                    {label}
                    {worker?.attempt ? ` · attempt ${worker.attempt}` : ''}
                  </small>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
