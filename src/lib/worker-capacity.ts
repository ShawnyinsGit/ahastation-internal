import type { MeetingPlanNode, WorkerStatus } from '../types';

/** Statuses that keep a live Backend session and consume a concurrency slot. */
const SLOT_HOLDING_STATUSES = new Set<WorkerStatus | string>([
  'running',
  'reworking',
]);

/**
 * Fallback statuses for dependencyGate: 'reviewed' when the plan node has not
 * yet projected `dependencyRelease` (older snapshots / partial fixtures).
 * Must stay aligned with electron/worker-scheduler REVIEWED_GATE_STATUSES —
 * no coordinator-reviewing, no integration-conflict.
 */
const REVIEWED_GATE_STATUSES = new Set<WorkerStatus | string>([
  'awaiting-acceptance',
  'integration-queued',
  'integrating',
  'accepted',
  'done',
]);

export function dependencyGateSatisfied(
  dependency: Pick<MeetingPlanNode, 'status' | 'dependencyGate' | 'dependencyRelease'> | undefined,
): boolean {
  if (!dependency) return false;
  const gate = dependency.dependencyGate ?? 'accepted';
  if (dependency.dependencyRelease) {
    if (gate === 'reviewed') {
      return dependency.dependencyRelease === 'reviewed'
        || dependency.dependencyRelease === 'accepted';
    }
    return dependency.dependencyRelease === 'accepted';
  }
  // Fallback when main has not projected release level yet.
  if (dependency.status === 'accepted' || dependency.status === 'done') return true;
  if (gate === 'reviewed') {
    return REVIEWED_GATE_STATUSES.has(dependency.status);
  }
  return false;
}

export function computeWorkerCapacity(nodes: readonly MeetingPlanNode[]): {
  active: number;
  waiting: number;
  saturated: boolean;
} {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const active = nodes.filter((node) => (
    SLOT_HOLDING_STATUSES.has(node.status)
    // A 'pending' node whose session is mid-launch already consumes a slot
    // (spawnWorker has reserved it). Count it as active so the banner reflects
    // real saturation instead of lagging one emit behind the backend.
    || node.launching === true
  )).length;
  const waiting = nodes.filter((node) => (
    node.status === 'pending'
    && node.launching !== true
    && node.deps.every((dependencyId) => dependencyGateSatisfied(byId.get(dependencyId)))
  )).length;
  return { active, waiting, saturated: active >= 4 && waiting > 0 };
}
