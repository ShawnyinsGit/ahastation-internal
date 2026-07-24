import { createHash } from 'node:crypto';
import { redactSecrets } from './format-error.js';
import type { DeliveryView } from './delivery-harness.js';

const MAX_TEXT = 4_000;
const MAX_ITEMS = 500;

export interface MeetingDeliveryTaskRecord {
  id: string;
  title: string;
  status: string;
  attempt?: number;
  approvedPlanVersion?: number;
  approvalDecisionId?: string;
  required?: boolean;
  delivery?: DeliveryView;
}

export interface MeetingDeliveryTaskEvidence {
  taskId: string;
  title: string;
  attempt: number;
  deliveryId: string;
  candidateId: string;
  candidateCommit: string;
  integratedCommit: string;
  reviewHash: string;
  verification: {
    passed: true;
    checks: Array<{ summary: string }>;
  };
  review: {
    passed: true;
    findings: Array<{ summary: string }>;
  };
  approvalDecisionId?: string;
  limitations: string[];
}

export interface MeetingDeliveryChangedFile {
  taskId: string;
  commit: string;
  path: string;
  previousPath?: string;
  status: string;
  evidenceKind: string;
  additions: number | null;
  deletions: number | null;
  requiresUserConfirmation: boolean;
}

export interface MeetingDelivery {
  schemaVersion: 1;
  id: string;
  meetingId: string;
  planVersion: number;
  integrationHead: string;
  expectedUserBaseRevision: string;
  publicationState: 'meeting-branch-only' | 'published';
  tasks: MeetingDeliveryTaskEvidence[];
  changedFiles: MeetingDeliveryChangedFile[];
  approvals: Array<{ taskId: string; decisionId: string }>;
  unresolvedWork: Array<{
    taskId: string;
    title: string;
    status: string;
    reason: string;
  }>;
  meetingVerification: {
    passed: true;
    integrationHead: string;
    checks: Array<{ taskId: string; summary: string }>;
  };
  contentHash: string;
}

export type FinalMeetingDecision =
  | {
      kind: 'accept';
      deliveryId: string;
      contentHash: string;
      integrationHead: string;
      decidedAt: number;
    }
  | {
      kind: 'rework';
      deliveryId: string;
      contentHash: string;
      reason: string;
      planVersion: number;
      taskIds: string[];
      decidedAt: number;
    };

export class MeetingDeliveryNotReadyError extends Error {
  readonly code = 'meeting-delivery-not-ready' as const;

  constructor(readonly blockers: string[]) {
    super(`Meeting delivery is not ready: ${blockers.join('; ')}`);
    this.name = 'MeetingDeliveryNotReadyError';
  }
}

/** Build the immutable, renderer-safe final delivery from durable accepted
 * task evidence. It deliberately selects fields instead of serializing task
 * records, so credentials, native handles and hidden Backend payloads cannot
 * enter the final manifest. */
export function buildMeetingDelivery(input: {
  meetingId: string;
  planVersion: number;
  tasks: MeetingDeliveryTaskRecord[];
  integrationHead: string;
  expectedUserBaseRevision: string;
  meetingVerification?: {
    integrationHead: string;
    checks: Array<{ taskId: string; summary: string }>;
  };
}): MeetingDelivery {
  const meetingId = boundedId(input.meetingId, 'meetingId');
  if (!Number.isSafeInteger(input.planVersion) || input.planVersion < 1) {
    throw new Error('planVersion must be a positive integer');
  }
  const integrationHead = commitId(input.integrationHead, 'integrationHead');
  const expectedUserBaseRevision = commitId(
    input.expectedUserBaseRevision,
    'expectedUserBaseRevision',
  );
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > MAX_ITEMS) {
    throw new Error('Meeting delivery requires 1-500 tasks');
  }

  const blockers: string[] = [];
  const accepted: MeetingDeliveryTaskEvidence[] = [];
  const changedFiles: MeetingDeliveryChangedFile[] = [];
  const approvals: Array<{ taskId: string; decisionId: string }> = [];
  const unresolvedWork: MeetingDelivery['unresolvedWork'] = [];
  const seenTaskIds = new Set<string>();

  for (const rawTask of [...input.tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    const taskId = boundedId(rawTask.id, 'task id');
    if (seenTaskIds.has(taskId)) throw new Error(`duplicate Meeting task: ${taskId}`);
    seenTaskIds.add(taskId);
    const title = safeText(rawTask.title || taskId);
    const required = rawTask.required !== false;
    if (rawTask.status !== 'accepted') {
      const status = safeText(rawTask.status || 'unknown');
      const reason = `Task is ${status}`;
      unresolvedWork.push({ taskId, title, status, reason });
      if (required) blockers.push(`${taskId}:${status}`);
      continue;
    }
    try {
      const evidence = acceptedTaskEvidence(rawTask);
      accepted.push(evidence);
      changedFiles.push(...acceptedTaskFiles(rawTask, evidence));
      if (evidence.approvalDecisionId) {
        approvals.push({ taskId, decisionId: evidence.approvalDecisionId });
      }
    } catch (error) {
      blockers.push(`${taskId}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (blockers.length > 0) throw new MeetingDeliveryNotReadyError(blockers);
  if (accepted.length === 0) {
    throw new MeetingDeliveryNotReadyError(['no accepted task evidence']);
  }
  const verificationHead = input.meetingVerification
    ? commitId(input.meetingVerification.integrationHead, 'Meeting verification head')
    : integrationHead;
  if (verificationHead !== integrationHead) {
    throw new MeetingDeliveryNotReadyError(['Meeting verification does not match integration head']);
  }
  const meetingVerification = {
    passed: true as const,
    integrationHead,
    checks: (
      input.meetingVerification?.checks
      ?? accepted.map((task) => ({
        taskId: task.taskId,
        summary: 'accepted task verification remains valid on the final integration head',
      }))
    ).slice(0, MAX_ITEMS).map((check) => ({
      taskId: boundedId(check.taskId, 'Meeting verification task id'),
      summary: safeText(check.summary),
    })),
  };

  const facts = {
    schemaVersion: 1 as const,
    meetingId,
    planVersion: input.planVersion,
    integrationHead,
    expectedUserBaseRevision,
    publicationState: 'meeting-branch-only' as const,
    tasks: accepted,
    changedFiles: changedFiles.sort((left, right) => (
      left.path.localeCompare(right.path) || left.taskId.localeCompare(right.taskId)
    )),
    approvals: approvals.sort((left, right) => left.taskId.localeCompare(right.taskId)),
    unresolvedWork,
    meetingVerification,
  };
  const contentHash = sha256(stableStringify(facts));
  return {
    ...facts,
    id: `meeting-delivery-${contentHash.slice(0, 24)}`,
    contentHash,
  };
}

export function publishedMeetingDelivery(delivery: MeetingDelivery): MeetingDelivery {
  if (delivery.publicationState === 'published') return structuredClone(delivery);
  const facts = {
    ...delivery,
    publicationState: 'published' as const,
  };
  // Publication is a lifecycle fact, not a content mutation. Keep the hash
  // bound to the reviewed delivery that the user accepted.
  return { ...facts, contentHash: delivery.contentHash };
}

/** Revalidate a journaled/IPC delivery, including the immutable content hash.
 * Published state is a lifecycle projection, so its hash is checked against
 * the original meeting-branch-only facts. */
export function parseMeetingDelivery(value: unknown): MeetingDelivery | null {
  if (!value || typeof value !== 'object') return null;
  const delivery = value as MeetingDelivery;
  if (
    delivery.schemaVersion !== 1
    || typeof delivery.id !== 'string'
    || typeof delivery.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(delivery.contentHash)
    || !Array.isArray(delivery.tasks)
    || !Array.isArray(delivery.changedFiles)
    || !delivery.meetingVerification
  ) return null;
  const { id: _id, contentHash, ...rawFacts } = delivery;
  const facts = {
    ...rawFacts,
    publicationState: 'meeting-branch-only' as const,
  };
  const expected = sha256(stableStringify(facts));
  if (
    expected !== contentHash
    || delivery.id !== `meeting-delivery-${contentHash.slice(0, 24)}`
  ) return null;
  return structuredClone(delivery);
}

function acceptedTaskEvidence(task: MeetingDeliveryTaskRecord): MeetingDeliveryTaskEvidence {
  const delivery = task.delivery;
  const candidate = delivery?.candidate;
  const frozen = candidate?.frozen;
  const reviewSession = candidate?.reviewSession;
  const integration = delivery?.integration;
  if (delivery?.status !== 'accepted' || !candidate || !frozen || !reviewSession || !integration) {
    throw new Error('accepted status lacks durable delivery evidence');
  }
  if (!candidate.verification.passed || !candidate.review.passed) {
    throw new Error('verification or Coordinator review is incomplete');
  }
  const resultRevision = typeof integration.resultRevision === 'string'
    ? integration.resultRevision
    : '';
  if (!resultRevision || !isCommitId(resultRevision)) {
    throw new Error('integration result revision is invalid');
  }
  return {
    taskId: boundedId(task.id, 'task id'),
    title: safeText(task.title || task.id),
    attempt: candidate.attempt,
    deliveryId: boundedId(delivery.id, 'delivery id'),
    candidateId: boundedId(candidate.id, 'candidate id'),
    candidateCommit: commitId(frozen.commit, 'candidate commit'),
    integratedCommit: resultRevision,
    reviewHash: hashId(reviewSession.reviewHash, 'review hash'),
    verification: {
      passed: true,
      checks: boundedSummaries(candidate.verification.checks),
    },
    review: {
      passed: true,
      findings: boundedSummaries(candidate.review.findings),
    },
    ...(task.approvalDecisionId
      ? { approvalDecisionId: boundedId(task.approvalDecisionId, 'approval decision id') }
      : {}),
    limitations: (candidate.report.unresolved ?? [])
      .slice(0, MAX_ITEMS)
      .map((item) => safeText(`${item.code}: ${item.message}`)),
  };
}

function acceptedTaskFiles(
  task: MeetingDeliveryTaskRecord,
  evidence: MeetingDeliveryTaskEvidence,
): MeetingDeliveryChangedFile[] {
  const files = task.delivery?.candidate?.frozen?.manifest.files ?? [];
  if (files.length > MAX_ITEMS) throw new Error('task changed-file manifest is too large');
  return files.map((file) => ({
    taskId: evidence.taskId,
    commit: evidence.integratedCommit,
    path: safeRelativePath(file.path),
    ...(file.previousPath ? { previousPath: safeRelativePath(file.previousPath) } : {}),
    status: safeText(file.status),
    evidenceKind: safeText(file.kind),
    additions: file.additions,
    deletions: file.deletions,
    requiresUserConfirmation: Boolean(file.requiresUserConfirmation),
  }));
}

function boundedSummaries(values: unknown[]): Array<{ summary: string }> {
  return (Array.isArray(values) ? values : []).slice(0, MAX_ITEMS).map((value) => {
    if (typeof value === 'string') return { summary: safeText(value) };
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const summary = record.summary ?? record.description ?? record.status ?? 'recorded';
      return { summary: safeText(String(summary)) };
    }
    return { summary: safeText(String(value)) };
  });
}

function safeRelativePath(value: string): string {
  const path = String(value ?? '').replaceAll('\\', '/').trim();
  if (
    !path
    || path.length > 4_096
    || path.startsWith('/')
    || /^[a-zA-Z]:\//u.test(path)
    || path.split('/').includes('..')
    || path.includes('\0')
  ) {
    throw new Error('final delivery contains an unsafe path');
  }
  return path;
}

function safeText(value: unknown): string {
  return redactSecrets(String(value ?? '')).trim().slice(0, MAX_TEXT);
}

function boundedId(value: string, label: string): string {
  const id = String(value ?? '').trim();
  if (!id || id.length > 500 || !/^[a-zA-Z0-9._:-]+$/u.test(id)) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

function commitId(value: string, label: string): string {
  const id = String(value ?? '').trim().toLowerCase();
  if (!isCommitId(id)) throw new Error(`${label} is invalid`);
  return id;
}

function hashId(value: string, label: string): string {
  const id = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function isCommitId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/u.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
