import { randomUUID } from 'node:crypto';
import { ipcMain, type WebContents } from 'electron';

import { redactSecrets } from '../format-error.js';
import type { PersistedMeetingEvent, PersistedTaskEventEnvelope } from '../meeting-repository.js';
import { taskMessageSchema, type TaskMessage } from '../task-collaboration.js';
import { taskBudgetSchema } from '../task-budget.js';
import { assessTaskRecovery } from '../task-recovery.js';
import type { IpcContext } from './context.js';

const ACTOR_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const SUBSCRIPTION_ID_RE = /^[a-zA-Z0-9._-]{1,200}$/;
const MAX_PAGE_EVENTS = 500;
const MAX_SUBSCRIPTION_REPLAY_EVENTS = 500;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_MAILBOX_MESSAGES = 500;
const MAX_SNAPSHOT_MAILBOX_BYTES = 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_REASON_CHARS = 20_000;

export interface RendererTaskEvent {
  schemaVersion: 1;
  eventId: string;
  seq: number;
  previousSeq: number;
  timestamp: number;
  taskId: string;
  attempt?: number;
  type: string;
  data: unknown;
}

export interface RendererTaskSnapshot {
  schemaVersion: 1;
  sessionId: string;
  meetingId: string;
  task: {
    id: string;
    title: string;
    prompt: string;
    deps: string[];
    dependencyGate?: 'reviewed' | 'accepted';
    status: string;
    backendId: string;
    attempt: number;
    summary?: string;
    requestedProfile?: unknown;
    effectiveProfile?: unknown;
    context?: {
      mode?: string;
      messageCount: number;
      decisionCount: number;
      dependencyReportCount: number;
      attachmentCount: number;
      byteLength?: number;
      packageHash?: string;
    };
    authority?: {
      allowedToolKinds: string[];
      writePathCount: number;
      commandCount: number;
      networkHostCount: number;
      hasEnvironmentAccess: boolean;
      expiresAt?: number;
    };
    workspace?: {
      kind?: string;
      branch?: string;
      sourceRevision?: string;
      managed?: boolean;
      diagnostic?: string;
    };
    acceptanceCriteria?: unknown[];
    budget?: {
      schemaVersion: 1;
      maxAttempts: number;
      maxTotalTokens: number;
      maxTotalDurationMs: number;
      maxStagnantAttempts: number;
    };
    budgetState?: {
      attempts: number;
      totalTokens: number;
      totalDurationMs: number;
      stagnantAttempts: number;
      reason?: string;
    };
    recovery?: {
      classification: string;
      reasonCode: string;
      allowedActions: string[];
      autoResume: boolean;
    };
  };
  mailbox: TaskMessage[];
  mailboxTruncated: boolean;
  attempts: Array<{
    attempt: number;
    backendId: string;
    status: string;
    startedAt?: number;
    finishedAt?: number;
    durationMs?: number;
    tokenCost?: number;
    report?: unknown;
    verification?: unknown;
    reviewCoverage?: unknown;
    candidateCommit?: string;
    failureFingerprint?: string | null;
    delivery?: unknown;
  }>;
  diagnostics: Array<{ code: string; message: string }>;
  reviewEvidence?: {
    reviewId: string;
    status: string;
    pending: Array<{
      chunkId: string;
      chunkHash: string;
      path: string;
      kind: string;
      byteLength: number;
      lineCount: number;
    }>;
    uncoveredChunkIds: string[];
    pauseReason?: string;
  };
  lastSeq: number;
}

type TaskIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: 'invalid-request' | 'not-found' | 'too-large' | 'failed' };

type TaskEventPage = {
  events: RendererTaskEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
};

interface Subscription {
  sender: WebContents;
  unsubscribe: () => void;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeText(value: unknown, max = MAX_TEXT_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  return redactSecrets(value).slice(0, max);
}

function redactRendererValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (depth > 32) return '[TRUNCATED]';
  if (typeof value === 'string') return redactSecrets(value).slice(0, MAX_TEXT_CHARS);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CYCLE]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 2_000)
      .map((entry) => redactRendererValue(entry, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 2_000)) {
    if (/api.?key|access.?token|authorization|credential|secret|nativepayload|rawpayload/i.test(key)) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = redactRendererValue(child, depth + 1, seen);
    }
  }
  seen.delete(value);
  return output;
}

function taskEnvelope(event: PersistedMeetingEvent): PersistedTaskEventEnvelope<unknown> | null {
  const payload = objectValue(event.payload);
  if (
    payload.schemaVersion !== 1
    || typeof payload.taskId !== 'string'
    || !payload.taskId
  ) return null;
  return payload as unknown as PersistedTaskEventEnvelope<unknown>;
}

function summarizeTaskEnvelope(
  event: PersistedMeetingEvent,
  envelope: PersistedTaskEventEnvelope<unknown>,
): unknown {
  const data = objectValue(envelope.data);
  if (event.type === 'task-message-enqueued') {
    const parsed = taskMessageSchema.safeParse(envelope.data);
    if (!parsed.success) return { invalid: true };
    return {
      message: {
        ...parsed.data,
        payload: redactRendererValue(parsed.data.payload),
      },
    };
  }
  if (
    event.type === 'task-message-delivered'
    || event.type === 'task-message-acknowledged'
    || event.type === 'task-message-failed'
  ) {
    return {
      messageId: typeof data.messageId === 'string' ? data.messageId : undefined,
      messageSeq: typeof data.messageSeq === 'number' ? data.messageSeq : undefined,
    };
  }
  if (event.type === 'context-package-frozen') {
    const context = objectValue(data.package);
    return {
      packageHash: safeText(context.packageHash, 100),
      mode: safeText(context.mode, 100),
      messageCount: Array.isArray(context.messages) ? context.messages.length : 0,
      decisionCount: Array.isArray(context.decisions) ? context.decisions.length : 0,
      dependencyReportCount: Array.isArray(context.dependencyReports)
        ? context.dependencyReports.length
        : 0,
      attachmentCount: Array.isArray(context.attachments) ? context.attachments.length : 0,
      byteLength: typeof context.byteLength === 'number' ? context.byteLength : undefined,
    };
  }
  if (event.type === 'task-authority-compiled') {
    const grant = objectValue(data.authorityGrant);
    return {
      grantHash: safeText(data.grantHash, 100),
      allowedToolKinds: Array.isArray(grant.allowedToolKinds)
        ? grant.allowedToolKinds.filter((entry): entry is string => typeof entry === 'string').slice(0, 1_000)
        : [],
      writePathCount: Array.isArray(grant.writePaths) ? grant.writePaths.length : 0,
      commandCount: Array.isArray(grant.allowedCommands) ? grant.allowedCommands.length : 0,
      networkHostCount: Array.isArray(grant.allowedNetworkHosts) ? grant.allowedNetworkHosts.length : 0,
      hasEnvironmentAccess: Array.isArray(grant.allowedEnvironmentKeys)
        && grant.allowedEnvironmentKeys.length > 0,
      expiresAt: typeof grant.expiresAt === 'number' ? grant.expiresAt : undefined,
    };
  }
  if (event.type === 'backend-profile-compiled') {
    return {
      requestedProfile: redactRendererValue(data.requestedProfile),
      effectiveProfile: redactRendererValue(data.effectiveProfile),
      runtime: redactRendererValue(data.runtime),
      capabilityHash: safeText(data.capabilityHash, 100),
    };
  }
  if (event.type === 'task-permission-decided') {
    return {
      requestId: safeText(data.nativeRequestId, 500),
      decision: safeText(data.decision, 100),
      reason: safeText(data.reason, 4_000),
      grantHash: safeText(data.grantHash, 100),
    };
  }
  if (event.type.startsWith('coordinator-review-')) {
    return {
      review: redactRendererValue(data.session),
    };
  }
  return {};
}

function latestReviewEvidence(events: readonly RendererTaskEvent[]): RendererTaskSnapshot['reviewEvidence'] {
  for (const event of [...events].reverse()) {
    if (!event.type.startsWith('coordinator-review-')) continue;
    const data = objectValue(event.data);
    const review = objectValue(data.review);
    const reviewId = safeText(review.id, 200);
    const status = safeText(review.status, 100);
    if (!reviewId || !status) continue;
    const confirmations = Array.isArray(review.confirmations)
      ? review.confirmations.map(objectValue)
      : [];
    const confirmed = new Set(confirmations.map((entry) => (
      `${safeText(entry.chunkId, 500) ?? ''}\0${safeText(entry.chunkHash, 100) ?? ''}`
    )));
    const pending = (Array.isArray(review.chunkEvidence) ? review.chunkEvidence : [])
      .map(objectValue)
      .filter((chunk) => chunk.requiresUserConfirmation === true)
      .filter((chunk) => !confirmed.has(
        `${safeText(chunk.id, 500) ?? ''}\0${safeText(chunk.hash, 100) ?? ''}`,
      ))
      .map((chunk) => ({
        chunkId: safeText(chunk.id, 500) ?? '',
        chunkHash: safeText(chunk.hash, 100) ?? '',
        path: safeText(chunk.path, 4_096) ?? 'withheld evidence',
        kind: safeText(chunk.kind, 100) ?? 'withheld',
        byteLength: typeof chunk.byteLength === 'number' ? chunk.byteLength : 0,
        lineCount: typeof chunk.lineCount === 'number' ? chunk.lineCount : 0,
      }))
      .filter((chunk) => chunk.chunkId && /^[a-f0-9]{64}$/i.test(chunk.chunkHash));
    const covered = new Set([
      ...(Array.isArray(review.reviews) ? review.reviews : [])
        .map((entry) => safeText(objectValue(entry).chunkId, 500) ?? ''),
      ...confirmations.map((entry) => safeText(entry.chunkId, 500) ?? ''),
    ]);
    const uncoveredChunkIds = (Array.isArray(review.chunkEvidence) ? review.chunkEvidence : [])
      .map((chunk) => safeText(objectValue(chunk).id, 500) ?? '')
      .filter((chunkId) => chunkId && !covered.has(chunkId))
      .slice(0, 20);
    const pauseReason = safeText(review.pauseReason, 100);
    return {
      reviewId,
      status,
      pending,
      uncoveredChunkIds,
      ...(pauseReason ? { pauseReason } : {}),
    };
  }
  return undefined;
}

function projectMeetingEventData(
  event: PersistedMeetingEvent,
  taskId: string,
): { attempt?: number; type: string; data: unknown } | null {
  const envelope = taskEnvelope(event);
  if (envelope) {
    if (envelope.taskId !== taskId) return null;
    return {
      ...(envelope.attempt ? { attempt: envelope.attempt } : {}),
      type: event.type,
      data: summarizeTaskEnvelope(event, envelope),
    };
  }

  const payload = objectValue(event.payload);
  const rendererEvent = objectValue(payload.event);
  if (rendererEvent.kind === 'worker-event') {
    const workerEvent = objectValue(rendererEvent.event);
    if (workerEvent.taskId !== taskId) return null;
    return {
      attempt: typeof workerEvent.attempt === 'number' ? workerEvent.attempt : undefined,
      type: 'worker-event',
      data: redactRendererValue(workerEvent.payload),
    };
  }
  if (
    rendererEvent.kind === 'worker-spawned'
    || rendererEvent.kind === 'worker-ended'
    || rendererEvent.kind === 'worker-delivery'
    || rendererEvent.kind === 'delivery-status'
  ) {
    const relatedId = rendererEvent.taskId ?? rendererEvent.workerId;
    if (relatedId !== taskId) return null;
    return {
      attempt: typeof rendererEvent.attempt === 'number' ? rendererEvent.attempt : undefined,
      type: String(rendererEvent.kind),
      data: redactRendererValue(rendererEvent),
    };
  }
  if (rendererEvent.kind === 'plan-updated') {
    const plan = objectValue(rendererEvent.plan);
    const nodes = Array.isArray(plan.nodes) ? plan.nodes : [];
    const node = nodes.map(objectValue).find((entry) => entry.id === taskId);
    if (!node) return null;
    return {
      type: 'task-plan-state',
      data: {
        status: safeText(node.status, 100),
        deps: Array.isArray(node.deps)
          ? node.deps.filter((entry): entry is string => typeof entry === 'string').slice(0, 1_000)
          : [],
        planVersion: typeof plan.version === 'number' ? plan.version : undefined,
      },
    };
  }
  return null;
}

export function projectRendererTaskEvents(
  events: readonly PersistedMeetingEvent[],
  taskId: string,
): RendererTaskEvent[] {
  const projected: RendererTaskEvent[] = [];
  let previousSeq = 0;
  const seenIds = new Set<string>();
  const seenSequences = new Set<number>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (seenIds.has(event.id) || seenSequences.has(event.seq)) continue;
    const taskEvent = projectSingleTaskEvent(event, taskId, previousSeq);
    if (!taskEvent) continue;
    seenIds.add(event.id);
    seenSequences.add(event.seq);
    projected.push(taskEvent);
    previousSeq = event.seq;
  }
  return projected;
}

function projectSingleTaskEvent(
  event: PersistedMeetingEvent,
  taskId: string,
  previousSeq: number,
): RendererTaskEvent | null {
  const view = projectMeetingEventData(event, taskId);
  if (!view) return null;
  return {
    schemaVersion: 1,
    eventId: event.id,
    seq: event.seq,
    previousSeq,
    timestamp: event.ts,
    taskId,
    ...(view.attempt ? { attempt: view.attempt } : {}),
    type: view.type,
    data: view.data,
  };
}

function boundedMailbox(messages: readonly TaskMessage[]): {
  messages: TaskMessage[];
  truncated: boolean;
} {
  const selected: TaskMessage[] = [];
  let bytes = 0;
  let truncated = messages.length > MAX_SNAPSHOT_MAILBOX_MESSAGES;
  for (const message of [...messages].slice(-MAX_SNAPSHOT_MAILBOX_MESSAGES).reverse()) {
    const safe = {
      ...message,
      payload: redactRendererValue(message.payload),
    } as TaskMessage;
    const size = Buffer.byteLength(JSON.stringify(safe), 'utf8');
    if (selected.length > 0 && bytes + size > MAX_SNAPSHOT_MAILBOX_BYTES) {
      truncated = true;
      break;
    }
    selected.push(safe);
    bytes += size;
  }
  return { messages: selected.reverse(), truncated };
}

function safeTaskSnapshot(raw: Record<string, unknown>): RendererTaskSnapshot['task'] {
  const context = objectValue(raw.contextPackage);
  const authority = objectValue(raw.authorityGrant);
  const workspace = objectValue(raw.workspace);
  const parsedBudget = taskBudgetSchema.safeParse(raw.budget);
  const budgetState = objectValue(raw.budgetState);
  const recovery = (
    raw.status === 'interrupted'
    || raw.status === 'integration-conflict'
    || raw.status === 'budget-paused'
  ) ? assessTaskRecovery(raw) : undefined;
  return {
    id: String(raw.id ?? ''),
    title: safeText(raw.title, 1_000) ?? '',
    prompt: safeText(raw.prompt, 20_000) ?? '',
    deps: Array.isArray(raw.deps)
      ? raw.deps.filter((entry): entry is string => typeof entry === 'string').slice(0, 1_000)
      : [],
    ...(raw.dependencyGate === 'reviewed' || raw.dependencyGate === 'accepted'
      ? { dependencyGate: raw.dependencyGate }
      : {}),
    status: String(raw.status ?? 'pending'),
    backendId: String(raw.executorBackendId ?? raw.backendId ?? 'unknown'),
    attempt: typeof raw.attempt === 'number' ? raw.attempt : 1,
    ...(safeText(raw.summary, 20_000) ? { summary: safeText(raw.summary, 20_000) } : {}),
    ...(raw.executionProfile ? { requestedProfile: redactRendererValue(raw.executionProfile) } : {}),
    ...(raw.effectiveProfile ? { effectiveProfile: redactRendererValue(raw.effectiveProfile) } : {}),
    ...(raw.contextPackage ? {
      context: {
        mode: safeText(context.mode, 100),
        messageCount: Array.isArray(context.messages) ? context.messages.length : 0,
        decisionCount: Array.isArray(context.decisions) ? context.decisions.length : 0,
        dependencyReportCount: Array.isArray(context.dependencyReports)
          ? context.dependencyReports.length
          : 0,
        attachmentCount: Array.isArray(context.attachments) ? context.attachments.length : 0,
        byteLength: typeof context.byteLength === 'number' ? context.byteLength : undefined,
        packageHash: safeText(context.packageHash, 100),
      },
    } : {}),
    ...(raw.authorityGrant ? {
      authority: {
        allowedToolKinds: Array.isArray(authority.allowedToolKinds)
          ? authority.allowedToolKinds.filter((entry): entry is string => typeof entry === 'string').slice(0, 1_000)
          : [],
        writePathCount: Array.isArray(authority.writePaths) ? authority.writePaths.length : 0,
        commandCount: Array.isArray(authority.allowedCommands) ? authority.allowedCommands.length : 0,
        networkHostCount: Array.isArray(authority.allowedNetworkHosts)
          ? authority.allowedNetworkHosts.length
          : 0,
        hasEnvironmentAccess: Array.isArray(authority.allowedEnvironmentKeys)
          && authority.allowedEnvironmentKeys.length > 0,
        expiresAt: typeof authority.expiresAt === 'number' ? authority.expiresAt : undefined,
      },
    } : {}),
    ...(raw.workspace ? {
      workspace: {
        kind: safeText(workspace.kind, 100),
        branch: safeText(workspace.branch, 500),
        sourceRevision: safeText(workspace.sourceRevision, 500),
        managed: typeof workspace.managed === 'boolean' ? workspace.managed : undefined,
        diagnostic: safeText(raw.workspaceDiagnostic, 500) ?? safeText(workspace.diagnostic, 500),
      },
    } : {}),
    ...(Array.isArray(raw.acceptanceCriteria)
      ? { acceptanceCriteria: redactRendererValue(raw.acceptanceCriteria) as unknown[] }
      : {}),
    ...(parsedBudget.success ? { budget: parsedBudget.data } : {}),
    ...(raw.budgetState ? {
      budgetState: {
        attempts: typeof budgetState.attempts === 'number' ? budgetState.attempts : 0,
        totalTokens: typeof budgetState.totalTokens === 'number' ? budgetState.totalTokens : 0,
        totalDurationMs: typeof budgetState.totalDurationMs === 'number'
          ? budgetState.totalDurationMs
          : 0,
        stagnantAttempts: typeof budgetState.stagnantAttempts === 'number'
          ? budgetState.stagnantAttempts
          : 0,
        ...(safeText(budgetState.reason, 200) ? { reason: safeText(budgetState.reason, 200) } : {}),
      },
    } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function parseRequest(payload: unknown): { sessionId: string; taskId: string } | null {
  const value = objectValue(payload);
  if (
    typeof value.sessionId !== 'string'
    || !ACTOR_ID_RE.test(value.sessionId)
    || typeof value.taskId !== 'string'
    || !ACTOR_ID_RE.test(value.taskId)
  ) return null;
  return { sessionId: value.sessionId, taskId: value.taskId };
}

function boundedInputText(
  payload: Record<string, unknown>,
  key: string,
  maxChars: number,
): string | null {
  const value = payload[key];
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxChars) return null;
  return normalized;
}

export class TaskIpcService {
  private subscriptions = new Map<string, Subscription>();

  constructor(private readonly ctx: IpcContext) {}

  async getSnapshot(payload: unknown): Promise<TaskIpcResult<RendererTaskSnapshot>> {
    const request = parseRequest(payload);
    if (!request) return { ok: false, error: 'Invalid sessionId or taskId', code: 'invalid-request' };
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found', code: 'not-found' };
    const source = await slot.orchestrator.getTaskInspectorSource(request.taskId);
    if (!source) return { ok: false, error: 'Task not found', code: 'not-found' };
    const events = projectRendererTaskEvents(source.events, request.taskId);
    const mailbox = boundedMailbox(source.mailbox);
    const durableRecord = (source.record ?? null) as unknown as Record<string, unknown> | null;
    const rawTask: Record<string, unknown> = {
      ...(source.task as unknown as Record<string, unknown>),
      ...(durableRecord ? {
        title: durableRecord.title,
        prompt: durableRecord.prompt,
        deps: durableRecord.deps,
        status: durableRecord.status,
        attempt: durableRecord.currentAttempt,
        executionProfile: durableRecord.requestedProfile,
        effectiveProfile: durableRecord.effectiveProfile,
        contextPackage: durableRecord.contextPackage,
        authorityGrant: durableRecord.authorityGrant,
        workspace: durableRecord.workspace,
      } : {}),
    };
    const task = safeTaskSnapshot(rawTask);
    const durableAttempts = durableRecord && Array.isArray(durableRecord.attempts)
      ? durableRecord.attempts.map(objectValue)
      : [];
    const attempts = durableAttempts.length > 0
      ? durableAttempts.map((attempt) => {
        const attemptNumber = typeof attempt.attempt === 'number' ? attempt.attempt : 1;
        const finishedAt = typeof attempt.finishedAt === 'number' ? attempt.finishedAt : undefined;
        const failureFingerprint = typeof attempt.failureFingerprint === 'string'
          ? attempt.failureFingerprint
          : attempt.failureFingerprint === null
            ? null
            : undefined;
        return {
          attempt: attemptNumber,
          backendId: safeText(attempt.backendId, 100) ?? task.backendId,
          status: failureFingerprint
            ? 'failed'
            : finishedAt !== undefined
              ? 'completed'
              : attemptNumber === task.attempt
                ? task.status
                : 'unknown',
          startedAt: typeof attempt.startedAt === 'number' ? attempt.startedAt : undefined,
          finishedAt,
          durationMs: typeof attempt.durationMs === 'number' ? attempt.durationMs : undefined,
          tokenCost: typeof attempt.tokenCost === 'number' ? attempt.tokenCost : undefined,
          ...(attempt.report ? { report: redactRendererValue(attempt.report) } : {}),
          ...(attempt.verification
            ? { verification: redactRendererValue(attempt.verification) }
            : {}),
          ...(attempt.reviewCoverage
            ? { reviewCoverage: redactRendererValue(attempt.reviewCoverage) }
            : {}),
          ...(safeText(attempt.candidateCommit, 500)
            ? { candidateCommit: safeText(attempt.candidateCommit, 500) }
            : {}),
          ...(failureFingerprint !== undefined ? { failureFingerprint } : {}),
          ...(attemptNumber === task.attempt && rawTask.delivery
            ? { delivery: redactRendererValue(rawTask.delivery) }
            : {}),
        };
      })
      : [{
        attempt: task.attempt,
        backendId: task.backendId,
        status: task.status,
        startedAt: typeof rawTask.startedAt === 'number' ? rawTask.startedAt : undefined,
        ...(rawTask.report ? { report: redactRendererValue(rawTask.report) } : {}),
        ...(rawTask.delivery ? { delivery: redactRendererValue(rawTask.delivery) } : {}),
      }];
    const reviewEvidence = latestReviewEvidence(events);
    const snapshot: RendererTaskSnapshot = {
      schemaVersion: 1,
      sessionId: request.sessionId,
      meetingId: source.meetingId,
      task,
      mailbox: mailbox.messages,
      mailboxTruncated: mailbox.truncated,
      attempts,
      diagnostics: (source.diagnostics ?? []).slice(-500).map((entry) => ({
        code: entry.code,
        message: safeText(entry.message, 2_000) ?? 'Task projection diagnostic',
      })),
      ...(reviewEvidence ? { reviewEvidence } : {}),
      lastSeq: events.at(-1)?.seq ?? 0,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_PAGE_BYTES) {
      return { ok: false, error: 'Task snapshot exceeds the IPC limit', code: 'too-large' };
    }
    return { ok: true, value: snapshot };
  }

  async getEvents(payload: unknown): Promise<TaskIpcResult<TaskEventPage>> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    if (
      !request
      || !Number.isSafeInteger(value.afterSeq)
      || (value.afterSeq as number) < 0
      || !Number.isFinite(value.limit)
      || (value.limit as number) <= 0
    ) {
      return { ok: false, error: 'Invalid task event cursor', code: 'invalid-request' };
    }
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found', code: 'not-found' };
    const source = await slot.orchestrator.getTaskInspectorSource(request.taskId);
    if (!source) return { ok: false, error: 'Task not found', code: 'not-found' };
    const limit = Math.max(1, Math.min(MAX_PAGE_EVENTS, Math.trunc(value.limit as number)));
    const candidates = projectRendererTaskEvents(source.events, request.taskId)
      .filter((event) => event.seq > (value.afterSeq as number));
    const events: RendererTaskEvent[] = [];
    let bytes = 0;
    for (const event of candidates) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
      if (events.length >= limit || (events.length > 0 && bytes + eventBytes > MAX_PAGE_BYTES)) break;
      events.push(event);
      bytes += eventBytes;
    }
    return {
      ok: true,
      value: {
        events,
        nextAfterSeq: events.at(-1)?.seq ?? (value.afterSeq as number),
        hasMore: events.length < candidates.length,
      },
    };
  }

  async subscribe(sender: WebContents, payload: unknown): Promise<TaskIpcResult<{ subscriptionId: string }>> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    if (
      !request
      || typeof value.subscriptionId !== 'string'
      || !SUBSCRIPTION_ID_RE.test(value.subscriptionId)
      || !Number.isSafeInteger(value.afterSeq)
      || (value.afterSeq as number) < 0
    ) {
      return { ok: false, error: 'Invalid task subscription', code: 'invalid-request' };
    }
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found', code: 'not-found' };
    const initial = await slot.orchestrator.getTaskInspectorSource(request.taskId);
    if (!initial) return { ok: false, error: 'Task not found', code: 'not-found' };

    const key = `${sender.id}:${value.subscriptionId}`;
    this.unsubscribe(sender, { subscriptionId: value.subscriptionId });
    const buffered: PersistedMeetingEvent[] = [];
    let replaying = true;
    let lastDeliveredSeq = value.afterSeq as number;
    const unsubscribe = slot.orchestrator.subscribeMeetingJournal((event) => {
      if (replaying) {
        buffered.push(event);
        return;
      }
      if (event.seq <= lastDeliveredSeq) return;
      const taskEvent = projectSingleTaskEvent(event, request.taskId, lastDeliveredSeq);
      if (!taskEvent) return;
      lastDeliveredSeq = taskEvent.seq;
      this.sendTaskEvent(sender, value.subscriptionId as string, taskEvent);
    });
    this.subscriptions.set(key, { sender, unsubscribe });
    sender.once('destroyed', () => this.unsubscribe(sender, { subscriptionId: value.subscriptionId }));

    try {
      const persisted = projectRendererTaskEvents(
        await slot.orchestrator.replayMeetingJournal(),
        request.taskId,
      ).filter((event) => event.seq > (value.afterSeq as number));
      if (persisted.length > MAX_SUBSCRIPTION_REPLAY_EVENTS) {
        this.unsubscribe(sender, { subscriptionId: value.subscriptionId });
        return {
          ok: false,
          error: 'Task subscription cursor is too old; fetch bounded event pages first',
          code: 'too-large',
        };
      }
      const deliveredIds = new Set<string>();
      for (const event of persisted) {
        deliveredIds.add(event.eventId);
        lastDeliveredSeq = event.seq;
        this.sendTaskEvent(sender, value.subscriptionId, event);
      }
      replaying = false;
      for (const rawEvent of buffered.sort((left, right) => left.seq - right.seq)) {
        if (rawEvent.seq <= lastDeliveredSeq || deliveredIds.has(rawEvent.id)) continue;
        const event = projectSingleTaskEvent(rawEvent, request.taskId, lastDeliveredSeq);
        if (!event) continue;
        lastDeliveredSeq = event.seq;
        this.sendTaskEvent(sender, value.subscriptionId, event);
      }
      return { ok: true, value: { subscriptionId: value.subscriptionId } };
    } catch (error) {
      this.unsubscribe(sender, { subscriptionId: value.subscriptionId });
      return {
        ok: false,
        error: error instanceof Error ? redactSecrets(error.message) : 'Task subscription failed',
        code: 'failed',
      };
    }
  }

  unsubscribe(sender: WebContents, payload: unknown): { ok: true } | { ok: false; error: string } {
    const value = objectValue(payload);
    if (typeof value.subscriptionId !== 'string' || !SUBSCRIPTION_ID_RE.test(value.subscriptionId)) {
      return { ok: false, error: 'Invalid subscriptionId' };
    }
    const key = `${sender.id}:${value.subscriptionId}`;
    const subscription = this.subscriptions.get(key);
    if (subscription) {
      subscription.unsubscribe();
      this.subscriptions.delete(key);
    }
    return { ok: true };
  }

  async followUp(payload: unknown): Promise<unknown> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    const text = boundedInputText(value, 'text', MAX_TEXT_CHARS);
    if (!request || !text) return { ok: false, error: 'Invalid follow-up request' };
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found' };
    try {
      const message = await slot.orchestrator.queueTaskFollowUp(request.taskId, text);
      return { ok: true, message };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? redactSecrets(error.message) : 'Failed to queue follow-up',
      };
    }
  }

  async steer(payload: unknown): Promise<unknown> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    const text = boundedInputText(value, 'text', MAX_TEXT_CHARS);
    if (!request || !text) return { ok: false, error: 'Invalid steering request' };
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found' };
    try {
      return await slot.orchestrator.steerWorker(request.taskId, text);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? redactSecrets(error.message) : 'Failed to steer task',
      };
    }
  }

  async interrupt(payload: unknown): Promise<unknown> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    const reason = value.reason === undefined
      ? undefined
      : boundedInputText(value, 'reason', MAX_REASON_CHARS);
    if (!request || (value.reason !== undefined && !reason)) {
      return { ok: false, error: 'Invalid interrupt request' };
    }
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found' };
    try {
      return await slot.orchestrator.interruptWorker(request.taskId, reason ?? undefined);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? redactSecrets(error.message) : 'Failed to interrupt task',
      };
    }
  }

  async extendBudget(payload: unknown): Promise<unknown> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    const budget = taskBudgetSchema.safeParse(value.budget);
    if (
      !request
      || !Number.isSafeInteger(value.expectedPlanVersion)
      || (value.expectedPlanVersion as number) < 0
      || !budget.success
    ) {
      return { ok: false, error: 'Invalid task budget extension request' };
    }
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found' };
    try {
      const result = await slot.orchestrator.extendTaskBudget(
        request.taskId,
        value.expectedPlanVersion as number,
        budget.data,
      );
      return { ok: true, ...result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? redactSecrets(error.message)
          : 'Failed to extend task budget',
      };
    }
  }

  async confirmReviewEvidence(payload: unknown): Promise<unknown> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    const reviewId = safeText(value.reviewId, 200);
    const chunkId = safeText(value.chunkId, 500);
    const chunkHash = safeText(value.chunkHash, 100);
    if (
      !request
      || !reviewId
      || !chunkId
      || !chunkHash
      || !ACTOR_ID_RE.test(reviewId)
      || !/^[a-f0-9]{64}$/i.test(chunkHash)
    ) {
      return { ok: false, error: 'Invalid review evidence confirmation' };
    }
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found' };
    try {
      const review = objectValue(slot.orchestrator.inspectDeliveryReview(reviewId));
      if (review.taskId !== request.taskId) {
        return { ok: false, error: 'Review does not belong to this task' };
      }
      const confirmed = await slot.orchestrator.confirmDeliveryReviewEvidence(reviewId, {
        chunkId,
        chunkHash,
        decisionId: `user-${randomUUID()}`,
      });
      return { ok: true, review: redactRendererValue(confirmed) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? redactSecrets(error.message)
          : 'Failed to confirm review evidence',
      };
    }
  }

  /**
   * Restart a Coordinator review that stalled out of its turn budget. This never
   * grants coverage — the Coordinator still has to submit every hash-bound
   * verdict; it only hands the model another chance before the user takes over.
   */
  async resumeReview(payload: unknown): Promise<unknown> {
    const request = parseRequest(payload);
    const value = objectValue(payload);
    const reviewId = safeText(value.reviewId, 200);
    if (!request || !reviewId || !ACTOR_ID_RE.test(reviewId)) {
      return { ok: false, error: 'Invalid review resume request' };
    }
    const slot = this.ctx.registry.get(request.sessionId);
    if (!slot) return { ok: false, error: 'Session not found' };
    try {
      const review = objectValue(slot.orchestrator.inspectDeliveryReview(reviewId));
      if (review.taskId !== request.taskId) {
        return { ok: false, error: 'Review does not belong to this task' };
      }
      const resumed = await slot.orchestrator.resumeDeliveryReview(reviewId);
      return { ok: true, review: redactRendererValue(resumed) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error
          ? redactSecrets(error.message)
          : 'Failed to resume review',
      };
    }
  }

  private sendTaskEvent(
    sender: WebContents,
    subscriptionId: string,
    event: RendererTaskEvent,
  ): void {
    if (sender.isDestroyed?.()) return;
    sender.send('tasks:event', { subscriptionId, event });
  }
}

export function registerTasksIpc(ctx: IpcContext): void {
  const service = new TaskIpcService(ctx);
  ipcMain.handle('tasks:get-snapshot', (_event, payload) => service.getSnapshot(payload));
  ipcMain.handle('tasks:get-events', (_event, payload) => service.getEvents(payload));
  ipcMain.handle('tasks:subscribe', (event, payload) => service.subscribe(event.sender, payload));
  ipcMain.on('tasks:unsubscribe', (event, payload) => {
    service.unsubscribe(event.sender, payload);
  });
  ipcMain.handle('tasks:follow-up', (_event, payload) => service.followUp(payload));
  ipcMain.handle('tasks:steer', (_event, payload) => service.steer(payload));
  ipcMain.handle('tasks:interrupt', (_event, payload) => service.interrupt(payload));
  ipcMain.handle('tasks:extend-budget', (_event, payload) => service.extendBudget(payload));
  ipcMain.handle(
    'tasks:confirm-review-evidence',
    (_event, payload) => service.confirmReviewEvidence(payload),
  );
  ipcMain.handle('tasks:resume-review', (_event, payload) => service.resumeReview(payload));
}
