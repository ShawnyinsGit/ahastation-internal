import { randomUUID } from 'node:crypto';
import {
  completeCoordinatorReview,
  confirmCoordinatorReviewEvidence,
  createCoordinatorReviewSession,
  getCoordinatorReviewChunk,
  safeCoordinatorReviewProjection,
  submitCoordinatorChunkReview,
  updateCoordinatorReviewLifecycle,
  type CoordinatorReviewFinding,
  type CoordinatorReviewSession,
} from './coordinator-review.js';
import type { FrozenDeliveryCandidate } from './delivery-candidate.js';
import type { VerificationEvidence } from './delivery-harness.js';

export interface CoordinatorReviewBriefing {
  schemaVersion: 1;
  reviewId: string;
  deliveryId: string;
  taskId?: string;
  attempt: number;
  status: CoordinatorReviewSession['status'];
  candidateCommit: string;
  diffHash: string;
  reviewedChunks: number;
  totalChunks: number;
  chunkId?: string;
  chunkHash?: string;
  path?: string;
  evidenceKind?: string;
  requiresUserConfirmation?: boolean;
  instruction: string;
}

export interface CoordinatorReviewDriverOptions {
  maxTurns?: number;
  now?: () => number;
  id?: () => string;
  append: (type: string, payload: unknown) => Promise<unknown>;
  flush: () => Promise<void>;
  notifyCoordinator: (briefing: CoordinatorReviewBriefing) => Promise<void> | void;
  onCompleted?: (session: CoordinatorReviewSession & { reviewHash: string }) => Promise<void> | void;
  onReworkRequested?: (session: CoordinatorReviewSession) => Promise<void> | void;
}

export class CoordinatorReviewDriver {
  private readonly sessions = new Map<string, CoordinatorReviewSession>();
  private readonly completedCallbacks = new Set<string>();
  private readonly reworkCallbacks = new Set<string>();
  private readonly maxTurns: number;
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly options: CoordinatorReviewDriverOptions) {
    this.maxTurns = options.maxTurns ?? 8;
    this.now = options.now ?? Date.now;
    this.id = options.id ?? randomUUID;
  }

  async request(input: {
    candidate: FrozenDeliveryCandidate;
    verification: VerificationEvidence;
  }): Promise<CoordinatorReviewSession> {
    const existing = this.findByDelivery(input.candidate.deliveryId, input.candidate.attempt);
    if (existing) {
      if (
        existing.candidate.commit !== input.candidate.commit
        || existing.candidate.diffHash !== input.candidate.diffHash
      ) {
        throw new Error('a different frozen candidate already owns this review attempt');
      }
      return structuredClone(existing);
    }
    if (!input.verification.passed) {
      throw new Error('Coordinator review requires passed deterministic verification');
    }
    const session = createCoordinatorReviewSession({
      reviewId: this.id(),
      candidate: input.candidate,
      maxTurns: this.maxTurns,
      now: this.now(),
    });
    this.sessions.set(session.id, session);
    await this.persist('coordinator-review-requested', session, {
      verificationHash: input.candidate.verificationHash,
    });
    await this.notify(session);
    return structuredClone(session);
  }

  restore(session: CoordinatorReviewSession): CoordinatorReviewSession {
    const cloned = structuredClone(session);
    if (this.sessions.has(cloned.id)) return this.inspect(cloned.id);
    // Re-run the pure assertions through an innocuous lookup before accepting
    // a recovered snapshot as the durable review owner.
    getCoordinatorReviewChunk(cloned);
    this.sessions.set(cloned.id, cloned);
    if (cloned.status === 'completed') this.completedCallbacks.add(cloned.id);
    if (cloned.status === 'rework-requested') this.reworkCallbacks.add(cloned.id);
    return structuredClone(cloned);
  }

  inspect(reviewId: string): CoordinatorReviewSession {
    return structuredClone(this.require(reviewId));
  }

  inspectByDelivery(deliveryId: string, attempt?: number): CoordinatorReviewSession | null {
    const found = this.findByDelivery(deliveryId, attempt);
    return found ? structuredClone(found) : null;
  }

  snapshot(): CoordinatorReviewSession[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((session) => structuredClone(session));
  }

  getChunk(reviewId: string, chunkId?: string) {
    const chunk = getCoordinatorReviewChunk(this.require(reviewId), chunkId);
    return chunk ? structuredClone(chunk) : null;
  }

  async submitChunkReview(
    reviewId: string,
    input: {
      chunkId: string;
      chunkHash: string;
      verdict: 'passed' | 'blocking';
      findings: CoordinatorReviewFinding[];
    },
  ): Promise<CoordinatorReviewSession> {
    const previous = this.require(reviewId);
    const next = submitCoordinatorChunkReview(previous, {
      ...input,
      reviewedAt: this.now(),
    });
    this.sessions.set(reviewId, next);
    if (stableStringify(previous) !== stableStringify(next)) {
      await this.persist('coordinator-review-chunk-submitted', next, {
        chunkId: input.chunkId,
        chunkHash: input.chunkHash,
        verdict: input.verdict,
        findings: next.reviews.find((review) => review.chunkId === input.chunkId)?.findings ?? [],
      });
    }
    if (next.status === 'rework-requested') {
      await this.emitRework(next);
    }
    return structuredClone(next);
  }

  async confirmEvidence(
    reviewId: string,
    input: {
      chunkId: string;
      chunkHash: string;
      decisionId: string;
    },
  ): Promise<CoordinatorReviewSession> {
    const previous = this.require(reviewId);
    const next = confirmCoordinatorReviewEvidence(previous, {
      ...input,
      confirmedAt: this.now(),
    });
    this.sessions.set(reviewId, next);
    if (stableStringify(previous) !== stableStringify(next)) {
      await this.persist('coordinator-review-evidence-confirmed', next, {
        chunkId: input.chunkId,
        chunkHash: input.chunkHash,
        decisionId: input.decisionId,
      });
    }
    return structuredClone(next);
  }

  async complete(reviewId: string): Promise<CoordinatorReviewSession & { reviewHash: string }> {
    const previous = this.require(reviewId);
    const next = completeCoordinatorReview(previous, this.now());
    this.sessions.set(reviewId, next);
    if (!previous.reviewHash) {
      await this.persist('coordinator-review-completed', next, {
        reviewHash: next.reviewHash,
      });
    }
    if (!this.completedCallbacks.has(reviewId)) {
      this.completedCallbacks.add(reviewId);
      await this.options.onCompleted?.(structuredClone(next));
    }
    return structuredClone(next);
  }

  async requestRework(
    reviewId: string,
    findings: CoordinatorReviewFinding[],
  ): Promise<CoordinatorReviewSession> {
    if (!findings.some((finding) => finding.blocking)) {
      throw new Error('rework requires at least one blocking finding');
    }
    const chunk = getCoordinatorReviewChunk(this.require(reviewId));
    if (!chunk || chunk.requiresUserConfirmation) {
      throw new Error('rework must be bound to a model-reviewable diff chunk');
    }
    return this.submitChunkReview(reviewId, {
      chunkId: chunk.id,
      chunkHash: chunk.hash,
      verdict: 'blocking',
      findings,
    });
  }

  async onCoordinatorTurnEnded(reviewId: string): Promise<CoordinatorReviewSession> {
    const current = this.require(reviewId);
    if (current.status !== 'active' || current.coverage.complete) {
      return structuredClone(current);
    }
    const turnCount = current.turnCount + 1;
    if (turnCount >= current.maxTurns) {
      const paused = updateCoordinatorReviewLifecycle(current, {
        status: 'paused',
        turnCount,
        pauseReason: 'review-turn-budget-exhausted',
        updatedAt: this.now(),
      });
      this.sessions.set(reviewId, paused);
      await this.persist('coordinator-review-paused', paused, {
        reason: paused.pauseReason,
      });
      return structuredClone(paused);
    }
    const queued = updateCoordinatorReviewLifecycle(current, {
      status: 'active',
      turnCount,
      updatedAt: this.now(),
    });
    this.sessions.set(reviewId, queued);
    await this.persist('coordinator-review-turn-queued', queued, {
      nextChunkId: getCoordinatorReviewChunk(queued)?.id ?? null,
    });
    await this.notify(queued);
    return structuredClone(queued);
  }

  async resume(reviewId: string): Promise<CoordinatorReviewSession> {
    const current = this.require(reviewId);
    if (current.status === 'completed' || current.status === 'rework-requested') {
      return structuredClone(current);
    }
    const resumed = updateCoordinatorReviewLifecycle(current, {
      status: 'active',
      pauseReason: undefined,
      updatedAt: this.now(),
    });
    this.sessions.set(reviewId, resumed);
    await this.persist('coordinator-review-resumed', resumed);
    await this.notify(resumed);
    return structuredClone(resumed);
  }

  async pauseForDisconnect(reviewId: string): Promise<CoordinatorReviewSession> {
    const current = this.require(reviewId);
    if (current.status !== 'active') return structuredClone(current);
    const paused = updateCoordinatorReviewLifecycle(current, {
      status: 'paused',
      pauseReason: 'coordinator-disconnected',
      updatedAt: this.now(),
    });
    this.sessions.set(reviewId, paused);
    await this.persist('coordinator-review-paused', paused, {
      reason: paused.pauseReason,
    });
    return structuredClone(paused);
  }

  private async notify(session: CoordinatorReviewSession): Promise<void> {
    const chunk = getCoordinatorReviewChunk(session);
    await this.options.notifyCoordinator({
      schemaVersion: 1,
      reviewId: session.id,
      deliveryId: session.deliveryId,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      attempt: session.attempt,
      status: session.status,
      candidateCommit: session.candidate.commit,
      diffHash: session.candidate.diffHash,
      reviewedChunks: session.coverage.reviewedChunks,
      totalChunks: session.coverage.totalChunks,
      ...(chunk ? {
        chunkId: chunk.id,
        chunkHash: chunk.hash,
        path: chunk.path,
        evidenceKind: chunk.kind,
        requiresUserConfirmation: chunk.requiresUserConfirmation,
      } : {}),
      instruction: chunk?.requiresUserConfirmation
        ? 'This evidence is withheld from the model and requires a user decision.'
        : 'Inspect the bounded chunk with the Coordinator review tools and submit a hash-bound verdict.',
    });
  }

  private async persist(
    type: string,
    session: CoordinatorReviewSession,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await this.options.append(type, {
      session: safeCoordinatorReviewProjection(session),
      ...(detail ? { detail } : {}),
    });
    await this.options.flush();
  }

  private async emitRework(session: CoordinatorReviewSession): Promise<void> {
    if (this.reworkCallbacks.has(session.id)) return;
    this.reworkCallbacks.add(session.id);
    await this.options.onReworkRequested?.(structuredClone(session));
  }

  private require(reviewId: string): CoordinatorReviewSession {
    const session = this.sessions.get(reviewId);
    if (!session) throw new Error(`Coordinator review not found: ${reviewId}`);
    return session;
  }

  private findByDelivery(
    deliveryId: string,
    attempt?: number,
  ): CoordinatorReviewSession | undefined {
    return [...this.sessions.values()].find(
      (session) => session.deliveryId === deliveryId
        && (attempt === undefined || session.attempt === attempt),
    );
  }
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
