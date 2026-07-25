import { createHash } from 'node:crypto';
import type {
  DeliveryDiffChunk,
} from './delivery-diff.js';
import type { FrozenDeliveryCandidate } from './delivery-candidate.js';

export type CoordinatorReviewStatus =
  | 'active'
  | 'paused'
  | 'rework-requested'
  | 'completed';

export interface CoordinatorReviewFinding {
  code: string;
  message: string;
  blocking: boolean;
  path?: string;
}

export interface CoordinatorChunkReview {
  chunkId: string;
  chunkHash: string;
  verdict: 'passed' | 'blocking';
  findings: CoordinatorReviewFinding[];
  reviewedAt: number;
  reviewer: 'coordinator';
}

export interface CoordinatorEvidenceConfirmation {
  chunkId: string;
  chunkHash: string;
  decisionId: string;
  confirmedAt: number;
  reviewer: 'user';
}

export interface CoordinatorReviewSession {
  schemaVersion: 1;
  id: string;
  deliveryId: string;
  taskId?: string;
  attempt: number;
  candidate: FrozenDeliveryCandidate;
  status: CoordinatorReviewStatus;
  cursor: number;
  reviews: CoordinatorChunkReview[];
  confirmations: CoordinatorEvidenceConfirmation[];
  coverage: {
    reviewedChunks: number;
    totalChunks: number;
    complete: boolean;
  };
  turnCount: number;
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
  pauseReason?: 'review-turn-budget-exhausted' | 'coordinator-disconnected' | 'user-required';
  rework?: {
    findings: CoordinatorReviewFinding[];
  };
  reviewHash?: string;
}

export function createCoordinatorReviewSession(input: {
  reviewId: string;
  candidate: FrozenDeliveryCandidate;
  maxTurns: number;
  now: number;
}): CoordinatorReviewSession {
  if (!input.reviewId.trim()) throw new Error('review id is required');
  if (!Number.isSafeInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 100) {
    throw new Error('review maxTurns must be in 1..100');
  }
  assertCandidate(input.candidate);
  return {
    schemaVersion: 1,
    id: input.reviewId,
    deliveryId: input.candidate.deliveryId,
    ...(input.candidate.taskId ? { taskId: input.candidate.taskId } : {}),
    attempt: input.candidate.attempt,
    candidate: structuredClone(input.candidate),
    status: 'active',
    cursor: 0,
    reviews: [],
    confirmations: [],
    coverage: {
      reviewedChunks: 0,
      totalChunks: input.candidate.manifest.chunks.length,
      complete: input.candidate.manifest.chunks.length === 0,
    },
    turnCount: 0,
    maxTurns: input.maxTurns,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function getCoordinatorReviewChunk(
  session: CoordinatorReviewSession,
  chunkId?: string,
): DeliveryDiffChunk | null {
  assertSession(session);
  if (chunkId) {
    const selected = session.candidate.manifest.chunks.find((chunk) => chunk.id === chunkId);
    if (!selected) throw new Error(`review chunk not found: ${chunkId}`);
    return structuredClone(selected);
  }
  const covered = coveredChunkIds(session);
  const next = session.candidate.manifest.chunks.find((chunk) => !covered.has(chunk.id));
  return next ? structuredClone(next) : null;
}

/** Chunk ids the Coordinator still owes a hash-bound verdict or user confirmation for. */
export function listUncoveredCoordinatorReviewChunkIds(
  session: CoordinatorReviewSession,
  limit = 20,
): string[] {
  assertSession(session);
  const covered = coveredChunkIds(session);
  return session.candidate.manifest.chunks
    .filter((chunk) => !covered.has(chunk.id))
    .slice(0, Math.max(0, limit))
    .map((chunk) => chunk.id);
}

export function submitCoordinatorChunkReview(
  session: CoordinatorReviewSession,
  input: {
    chunkId: string;
    chunkHash: string;
    verdict: 'passed' | 'blocking';
    findings: CoordinatorReviewFinding[];
    reviewedAt: number;
  },
): CoordinatorReviewSession {
  const next = mutableActiveSession(session);
  const chunk = requireChunk(next, input.chunkId, input.chunkHash);
  if (chunk.requiresUserConfirmation) {
    throw new Error(`review chunk ${chunk.id} requires explicit user confirmation`);
  }
  const normalizedFindings = normalizeFindings(input.findings);
  if (
    input.verdict === 'blocking'
    && !normalizedFindings.some((finding) => finding.blocking)
  ) {
    throw new Error('blocking review requires at least one blocking finding');
  }
  if (
    input.verdict === 'passed'
    && normalizedFindings.some((finding) => finding.blocking)
  ) {
    throw new Error('passed review cannot include a blocking finding');
  }
  const existing = next.reviews.find((review) => review.chunkId === chunk.id);
  const review: CoordinatorChunkReview = {
    chunkId: chunk.id,
    chunkHash: chunk.hash,
    verdict: input.verdict,
    findings: normalizedFindings,
    reviewedAt: input.reviewedAt,
    reviewer: 'coordinator',
  };
  if (existing) {
    if (stableStringify(existing) !== stableStringify(review)) {
      throw new Error(`conflicting review already exists for ${chunk.id}`);
    }
    return next;
  }
  next.reviews.push(review);
  next.updatedAt = input.reviewedAt;
  // turnCount is a stall counter, not a lifetime turn budget: real coverage
  // progress must not be punished just because the Coordinator also handled
  // unrelated user turns while the review was open.
  next.turnCount = 0;
  if (input.verdict === 'blocking') {
    next.status = 'rework-requested';
    next.rework = { findings: normalizedFindings.filter((finding) => finding.blocking) };
  }
  return refreshCoverage(next);
}

export function confirmCoordinatorReviewEvidence(
  session: CoordinatorReviewSession,
  input: {
    chunkId: string;
    chunkHash: string;
    decisionId: string;
    confirmedAt: number;
  },
): CoordinatorReviewSession {
  const next = mutableActiveSession(session);
  const chunk = requireChunk(next, input.chunkId, input.chunkHash);
  if (!chunk.requiresUserConfirmation) {
    throw new Error(`review chunk ${chunk.id} does not require user confirmation`);
  }
  if (!input.decisionId.trim()) throw new Error('user decision id is required');
  const existing = next.confirmations.find((confirmation) => confirmation.chunkId === chunk.id);
  const confirmation: CoordinatorEvidenceConfirmation = {
    chunkId: chunk.id,
    chunkHash: chunk.hash,
    decisionId: input.decisionId.trim(),
    confirmedAt: input.confirmedAt,
    reviewer: 'user',
  };
  if (existing) {
    if (stableStringify(existing) !== stableStringify(confirmation)) {
      throw new Error(`conflicting evidence confirmation exists for ${chunk.id}`);
    }
    return next;
  }
  next.confirmations.push(confirmation);
  next.updatedAt = input.confirmedAt;
  next.turnCount = 0;
  return refreshCoverage(next);
}

export function completeCoordinatorReview(
  session: CoordinatorReviewSession,
  completedAt = Date.now(),
): CoordinatorReviewSession & { reviewHash: string } {
  const next = structuredClone(session);
  assertSession(next);
  if (next.status === 'completed' && next.reviewHash) {
    return next as CoordinatorReviewSession & { reviewHash: string };
  }
  if (next.status === 'rework-requested') {
    throw new Error('blocking findings require rework');
  }
  const refreshed = refreshCoverage(next);
  if (!refreshed.coverage.complete) {
    throw new Error('incomplete review coverage');
  }
  const blocking = refreshed.reviews.flatMap((review) => review.findings)
    .filter((finding) => finding.blocking);
  if (blocking.length > 0) throw new Error('blocking findings require rework');
  refreshed.status = 'completed';
  refreshed.updatedAt = completedAt;
  refreshed.reviewHash = reviewHash(refreshed);
  return refreshed as CoordinatorReviewSession & { reviewHash: string };
}

export function replaceCoordinatorReviewCandidate(
  session: CoordinatorReviewSession,
  candidate: FrozenDeliveryCandidate,
  updatedAt = Date.now(),
): CoordinatorReviewSession {
  assertCandidate(candidate);
  if (
    candidate.deliveryId !== session.deliveryId
    || candidate.attempt !== session.attempt
  ) {
    throw new Error('replacement candidate identity mismatch');
  }
  const next = structuredClone(session);
  const chunkHashById = new Map(
    candidate.manifest.chunks.map((chunk) => [chunk.id, chunk.hash]),
  );
  next.candidate = structuredClone(candidate);
  next.reviews = next.reviews.filter(
    (review) => chunkHashById.get(review.chunkId) === review.chunkHash,
  );
  next.confirmations = next.confirmations.filter(
    (confirmation) => chunkHashById.get(confirmation.chunkId) === confirmation.chunkHash,
  );
  next.status = 'active';
  next.rework = undefined;
  next.pauseReason = undefined;
  next.reviewHash = undefined;
  next.updatedAt = updatedAt;
  return refreshCoverage(next);
}

export function updateCoordinatorReviewLifecycle(
  session: CoordinatorReviewSession,
  input: {
    status: 'active' | 'paused';
    turnCount?: number;
    pauseReason?: CoordinatorReviewSession['pauseReason'];
    updatedAt: number;
  },
): CoordinatorReviewSession {
  if (session.status === 'completed' || session.status === 'rework-requested') {
    return structuredClone(session);
  }
  const next = structuredClone(session);
  next.status = input.status;
  if (input.turnCount !== undefined) next.turnCount = input.turnCount;
  next.pauseReason = input.pauseReason;
  next.updatedAt = input.updatedAt;
  return next;
}

export function safeCoordinatorReviewProjection(session: CoordinatorReviewSession): {
  schemaVersion: 1;
  id: string;
  deliveryId: string;
  taskId?: string;
  attempt: number;
  candidate: {
    id: string;
    commit: string;
    tree: string;
    baseRevision: string;
    reportHash: string;
    verificationHash: string;
    diffHash: string;
  };
  status: CoordinatorReviewStatus;
  cursor: number;
  chunkEvidence: Array<Omit<DeliveryDiffChunk, 'content'>>;
  reviews: CoordinatorChunkReview[];
  confirmations: CoordinatorEvidenceConfirmation[];
  coverage: CoordinatorReviewSession['coverage'];
  turnCount: number;
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
  pauseReason?: CoordinatorReviewSession['pauseReason'];
  rework?: CoordinatorReviewSession['rework'];
  reviewHash?: string;
} {
  return {
    schemaVersion: 1,
    id: session.id,
    deliveryId: session.deliveryId,
    ...(session.taskId ? { taskId: session.taskId } : {}),
    attempt: session.attempt,
    candidate: {
      id: session.candidate.id,
      commit: session.candidate.commit,
      tree: session.candidate.tree,
      baseRevision: session.candidate.baseRevision,
      reportHash: session.candidate.reportHash,
      verificationHash: session.candidate.verificationHash,
      diffHash: session.candidate.diffHash,
    },
    status: session.status,
    cursor: session.cursor,
    chunkEvidence: session.candidate.manifest.chunks.map(({ content: _content, ...chunk }) => chunk),
    reviews: structuredClone(session.reviews),
    confirmations: structuredClone(session.confirmations),
    coverage: structuredClone(session.coverage),
    turnCount: session.turnCount,
    maxTurns: session.maxTurns,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.pauseReason ? { pauseReason: session.pauseReason } : {}),
    ...(session.rework ? { rework: structuredClone(session.rework) } : {}),
    ...(session.reviewHash ? { reviewHash: session.reviewHash } : {}),
  };
}

function mutableActiveSession(session: CoordinatorReviewSession): CoordinatorReviewSession {
  assertSession(session);
  if (session.status === 'completed') throw new Error('review is already completed');
  if (session.status === 'paused') throw new Error('review is paused');
  if (session.status === 'rework-requested') throw new Error('review already requires rework');
  return structuredClone(session);
}

function requireChunk(
  session: CoordinatorReviewSession,
  chunkId: string,
  chunkHash: string,
): DeliveryDiffChunk {
  const chunk = session.candidate.manifest.chunks.find((item) => item.id === chunkId);
  if (!chunk) throw new Error(`review chunk not found: ${chunkId}`);
  if (chunk.hash !== chunkHash) throw new Error(`review chunk hash mismatch: ${chunkId}`);
  return chunk;
}

function refreshCoverage(session: CoordinatorReviewSession): CoordinatorReviewSession {
  const covered = coveredChunkIds(session);
  session.cursor = session.candidate.manifest.chunks.findIndex((chunk) => !covered.has(chunk.id));
  if (session.cursor < 0) session.cursor = session.candidate.manifest.chunks.length;
  session.coverage = {
    reviewedChunks: covered.size,
    totalChunks: session.candidate.manifest.chunks.length,
    complete: covered.size === session.candidate.manifest.chunks.length,
  };
  return session;
}

function coveredChunkIds(session: CoordinatorReviewSession): Set<string> {
  return new Set([
    ...session.reviews.map((review) => review.chunkId),
    ...session.confirmations.map((confirmation) => confirmation.chunkId),
  ]);
}

function normalizeFindings(findings: CoordinatorReviewFinding[]): CoordinatorReviewFinding[] {
  if (!Array.isArray(findings) || findings.length > 100) {
    throw new Error('review findings exceed the supported bound');
  }
  return findings.map((finding) => {
    const code = finding.code?.trim();
    const message = finding.message?.trim();
    if (!code || code.length > 200 || !message || message.length > 4_000) {
      throw new Error('review finding is invalid');
    }
    return {
      code,
      message,
      blocking: Boolean(finding.blocking),
      ...(finding.path?.trim() ? { path: finding.path.trim().slice(0, 4_096) } : {}),
    };
  });
}

function reviewHash(session: CoordinatorReviewSession): string {
  return sha256(stableStringify({
    candidateId: session.candidate.id,
    commit: session.candidate.commit,
    tree: session.candidate.tree,
    diffHash: session.candidate.diffHash,
    reviews: [...session.reviews].sort((left, right) => left.chunkId.localeCompare(right.chunkId)),
    confirmations: [...session.confirmations]
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId)),
  }));
}

function assertCandidate(candidate: FrozenDeliveryCandidate): void {
  if (
    candidate.schemaVersion !== 1
    || !candidate.id
    || !candidate.deliveryId
    || !candidate.commit
    || !candidate.tree
    || !candidate.diffHash
    || candidate.manifest.diffHash !== candidate.diffHash
  ) {
    throw new Error('frozen candidate is invalid');
  }
}

function assertSession(session: CoordinatorReviewSession): void {
  if (session.schemaVersion !== 1 || !session.id || !session.deliveryId) {
    throw new Error('coordinator review session is invalid');
  }
  assertCandidate(session.candidate);
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
