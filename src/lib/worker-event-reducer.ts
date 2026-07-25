import type { CommandRun, WorkReport, WorkerEventV2, WorkerStatus } from '../types';
import { rendererWorkerEventSchema } from './worker-event-schema.ts';

export const COMMAND_LOG_CAP = 200;

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
  commandLog?: CommandRun[];
}

function isBashTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'bash';
}

/** Upsert a Bash command entry keyed by callId (or a synthetic fallback id). */
export function upsertCommandLog(
  log: CommandRun[] | undefined,
  patch: {
    callId?: string;
    command?: string;
    phase: 'started' | 'completed' | 'failed';
    output?: string;
    exitCode?: number;
    durationMs?: number;
    timestamp: number;
    backendId?: string;
    source?: string;
  },
): CommandRun[] {
  const next = [...(log ?? [])];
  const id = patch.callId?.trim() || `anon-${patch.timestamp}-${next.length}`;
  const existingIdx = next.findIndex((entry) => entry.id === id);
  if (patch.phase === 'started') {
    const started: CommandRun = {
      id,
      command: patch.command?.trim() || next[existingIdx]?.command || '',
      status: 'running',
      startedAt: patch.timestamp,
      ...(patch.backendId ? { backendId: patch.backendId } : {}),
      ...(patch.source ? { source: patch.source } : {}),
    };
    if (existingIdx >= 0) next[existingIdx] = { ...next[existingIdx], ...started };
    else next.push(started);
  } else {
    const prev = existingIdx >= 0 ? next[existingIdx] : undefined;
    const completed: CommandRun = {
      id,
      command: patch.command?.trim() || prev?.command || '',
      status: patch.phase === 'failed' ? 'failed' : 'completed',
      startedAt: prev?.startedAt ?? patch.timestamp,
      endedAt: patch.timestamp,
      ...(patch.output !== undefined ? { output: patch.output } : prev?.output ? { output: prev.output } : {}),
      ...(patch.exitCode !== undefined
        ? { exitCode: patch.exitCode }
        : prev?.exitCode !== undefined
          ? { exitCode: prev.exitCode }
          : {}),
      ...(patch.durationMs !== undefined
        ? { durationMs: patch.durationMs }
        : prev?.durationMs !== undefined
          ? { durationMs: prev.durationMs }
          : prev
            ? { durationMs: Math.max(0, patch.timestamp - prev.startedAt) }
            : {}),
      ...(patch.backendId || prev?.backendId
        ? { backendId: patch.backendId ?? prev?.backendId }
        : {}),
      ...(patch.source || prev?.source ? { source: patch.source ?? prev?.source } : {}),
    };
    if (existingIdx >= 0) next[existingIdx] = completed;
    else next.push(completed);
  }
  return next.length > COMMAND_LOG_CAP ? next.slice(-COMMAND_LOG_CAP) : next;
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
    if (isBashTool(signal.toolName)) {
      next.commandLog = upsertCommandLog(current.commandLog, {
        callId: signal.callId,
        command: signal.detail,
        phase: signal.phase,
        output: signal.output,
        exitCode: signal.exitCode,
        durationMs: signal.durationMs,
        timestamp: valid.timestamp,
        backendId: valid.backendId,
        source: valid.workerId,
      });
    }
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
