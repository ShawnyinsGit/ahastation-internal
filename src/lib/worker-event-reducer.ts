import type { WorkReport, WorkerEventV2, WorkerStatus } from '../types';
import { rendererWorkerEventSchema } from './worker-event-schema.ts';

export interface WorkerEventProjection {
  eventSeq?: number;
  backendId?: string;
  attempt?: number;
  lastText: string;
  currentTool: string | null;
  currentToolInput: string | null;
  summary: string;
  status: 'idle' | WorkerStatus;
  workReport?: WorkReport;
  workerEvents?: WorkerEventV2[];
}

/** Provider-neutral renderer projection. Events with a duplicate/out-of-order
 * sequence or the wrong source are ignored, so the UI and journal replay use
 * the same monotonic identity contract. */
export function reduceWorkerEvent(
  current: WorkerEventProjection,
  incoming: WorkerEventV2,
  source: string | undefined,
): WorkerEventProjection {
  const parsed = rendererWorkerEventSchema.safeParse(incoming);
  if (!parsed.success) return current;
  const valid = parsed.data as WorkerEventV2;
  if (valid.workerId !== source) return current;
  if ((current.eventSeq ?? 0) >= valid.seq) return current;
  const next: WorkerEventProjection = {
    ...current,
    backendId: valid.backendId,
    attempt: valid.attempt,
    eventSeq: valid.seq,
    workerEvents: [...(current.workerEvents ?? []), valid].slice(-200),
  };
  const signal = valid.payload;
  if (signal.kind === 'progress') {
    next.lastText = signal.message;
  } else if (signal.kind === 'tool') {
    next.currentTool = signal.phase === 'started' ? signal.toolName : null;
    next.currentToolInput = signal.detail ?? null;
  } else if (signal.kind === 'delivery') {
    next.workReport = signal.report;
    next.summary = signal.report.summary;
  } else if (signal.kind === 'failed') {
    next.summary = signal.message;
    next.status = 'failed';
  } else if (signal.kind === 'ended' && signal.reason === 'interrupted') {
    next.status = 'interrupted';
  }
  return next;
}
