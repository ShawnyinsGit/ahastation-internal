import { createHash, randomUUID } from 'node:crypto';
import type { CoordinatorReviewDriver } from './coordinator-review-driver.js';
import type { CoordinatorReviewSession } from './coordinator-review.js';
import type { FrozenDeliveryCandidate } from './delivery-candidate.js';
import type { AcceptanceCriterion, WorkReport } from './worker-protocol.js';

export type { AcceptanceCriterion, WorkReport } from './worker-protocol.js';

export type DeliveryStatus =
  | 'awaiting-spec-approval'
  | 'preparing-workspace'
  | 'executing'
  | 'verifying'
  | 'reviewing'
  | 'coordinator-reviewing'
  | 'awaiting-delivery-acceptance'
  | 'integrating'
  | 'accepted'
  | 'reworking'
  | 'interrupted'
  | 'failed'
  | 'cancelled';

export interface DeliveryProposal {
  meetingId: string;
  taskId?: string;
  objective: string;
  workspace: string;
  sourceRevision: string;
  acceptanceCriteria: AcceptanceCriterion[];
}

export interface DeliverySpec {
  version: number;
  taskId?: string;
  objective: string;
  acceptanceCriteria: AcceptanceCriterion[];
}

export interface WorkOrder {
  deliveryId: string;
  taskId?: string;
  attempt: number;
  meetingId: string;
  goal: string;
  acceptanceCriteria: AcceptanceCriterion[];
  workspace: string;
  sourceRevision: string;
}

export interface VerificationEvidence {
  passed: boolean;
  checks: unknown[];
  error?: string;
}

export interface ReviewVerdict {
  passed: boolean;
  findings: unknown[];
}

export interface DeliveryCandidate {
  id: string;
  attempt: number;
  report: WorkReport;
  verification: VerificationEvidence;
  review: ReviewVerdict;
  frozen?: FrozenDeliveryCandidate;
  reviewSession?: {
    id: string;
    reviewHash: string;
  };
}

export interface DeliveryAttempt {
  attempt: number;
  report: WorkReport;
  verification?: VerificationEvidence;
  review?: ReviewVerdict;
  outcome:
    | 'reported'
    | 'worker-incomplete'
    | 'verification-failed'
    | 'review-failed'
    | 'coordinator-reviewing'
    | 'awaiting-acceptance'
    | 'returned'
    | 'accepted';
  feedback?: string;
  updatedAt: number;
}

export interface DeliveryView {
  id: string;
  meetingId: string;
  status: DeliveryStatus;
  spec: DeliverySpec;
  sourceRevision: string;
  workspace: string;
  attempt: number;
  candidate?: DeliveryCandidate;
  attempts: DeliveryAttempt[];
  integration?: Record<string, unknown>;
  error?: string;
  updatedAt: number;
}

export type DeliveryDecision =
  | { kind: 'approve-spec'; specVersion: number }
  | { kind: 'revise-spec'; feedback: string }
  | { kind: 'accept-delivery'; candidateId: string }
  | { kind: 'return-delivery'; candidateId?: string; feedback: string }
  | { kind: 'resume-after-interruption'; mode: 'continue' | 'retry' }
  | { kind: 'cancel' };

export interface DeliveryEvent {
  deliveryId: string;
  seq: number;
  type: 'delivery.proposed' | 'delivery.spec-revised' | 'delivery.status-changed' | 'delivery.failed' | 'delivery.accepted';
  timestamp: number;
  status: DeliveryStatus;
  detail?: unknown;
}

export interface DeliveryHarnessDependencies {
  executionMode?: 'internal' | 'external';
  runtime?: {
    execute(order: WorkOrder, signal: AbortSignal): Promise<WorkReport>;
  };
  verifier: {
    verify(order: WorkOrder, report: WorkReport): Promise<VerificationEvidence>;
  };
  reviewer: {
    review(order: WorkOrder, report: WorkReport, verification: VerificationEvidence): Promise<ReviewVerdict>;
  };
  candidatePreparer?: {
    prepare(
      order: WorkOrder,
      report: WorkReport,
      verification: VerificationEvidence,
    ): Promise<FrozenDeliveryCandidate>;
  };
  reviewDriver?: CoordinatorReviewDriver;
  integrator: {
    integrate(view: DeliveryView, candidate: DeliveryCandidate): Promise<Record<string, unknown>>;
  };
  now?: () => number;
  id?: () => string;
}

type DeliveryRecord = {
  view: DeliveryView;
  events: DeliveryEvent[];
  subscribers: Set<(event: DeliveryEvent) => void>;
  submittedAttempts: Set<number>;
  abort?: AbortController;
};

/** Authoritative delivery state machine. Agent runtimes can execute work, but
 * only this module can advance a delivery through verification, review,
 * acceptance, and integration. */
export class DeliveryHarness {
  private readonly records = new Map<string, DeliveryRecord>();
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly deps: DeliveryHarnessDependencies) {
    this.now = deps.now ?? Date.now;
    this.id = deps.id ?? randomUUID;
  }

  /** Restore a journaled delivery without executing it. Any state that was
   * live at the time of the crash becomes interrupted and requires an
   * explicit user resume decision before another Worker attempt can start. */
  restore(input: DeliveryView): DeliveryView {
    if (this.records.has(input.id)) return cloneView(this.records.get(input.id)!.view);
    const view = cloneView(input);
    if (!isTerminal(view.status)) {
      view.status = 'interrupted';
      view.candidate = undefined;
      view.error = 'Meeting restarted before the delivery was accepted.';
      view.updatedAt = this.now();
    }
    const record: DeliveryRecord = {
      view,
      events: [],
      subscribers: new Set(),
      submittedAttempts: new Set(view.attempts.map((attempt) => attempt.attempt)),
    };
    this.records.set(view.id, record);
    this.append(record, 'delivery.status-changed', { recovered: true });
    return cloneView(view);
  }

  snapshot(id: string): DeliveryView | undefined {
    const record = this.records.get(id);
    return record ? cloneView(record.view) : undefined;
  }

  async propose(input: DeliveryProposal): Promise<DeliveryView> {
    if (!input.objective.trim()) throw new Error('delivery objective is required');
    if (input.acceptanceCriteria.length === 0) throw new Error('at least one acceptance criterion is required');
    const id = this.id();
    const view: DeliveryView = {
      id,
      meetingId: input.meetingId,
      status: 'awaiting-spec-approval',
      spec: {
        version: 1,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        objective: input.objective,
        acceptanceCriteria: structuredClone(input.acceptanceCriteria),
      },
      sourceRevision: input.sourceRevision,
      workspace: input.workspace,
      attempt: 0,
      attempts: [],
      updatedAt: this.now(),
    };
    const record: DeliveryRecord = {
      view,
      events: [],
      subscribers: new Set(),
      submittedAttempts: new Set(),
    };
    this.records.set(id, record);
    this.append(record, 'delivery.proposed');
    return cloneView(view);
  }

  async decide(id: string, decision: DeliveryDecision): Promise<DeliveryView> {
    const record = this.require(id);
    switch (decision.kind) {
      case 'approve-spec':
        if (record.view.status !== 'awaiting-spec-approval') throw new Error('delivery is not awaiting spec approval');
        if (decision.specVersion !== record.view.spec.version) throw new Error('spec version conflict');
        record.view.attempt += 1;
        this.transition(record, 'preparing-workspace');
        if ((this.deps.executionMode ?? 'internal') === 'external') {
          this.transition(record, 'executing');
        } else {
          void this.execute(record);
        }
        break;
      case 'revise-spec':
        if (record.view.status !== 'awaiting-spec-approval') throw new Error('delivery is not awaiting spec revision');
        record.view.spec = {
          ...record.view.spec,
          version: record.view.spec.version + 1,
          objective: `${record.view.spec.objective}\n\nRevision request: ${decision.feedback}`,
        };
        record.view.updatedAt = this.now();
        this.append(record, 'delivery.spec-revised', { specVersion: record.view.spec.version });
        break;
      case 'accept-delivery': {
        if (record.view.status !== 'awaiting-delivery-acceptance' || !record.view.candidate) {
          throw new Error('delivery is not ready for acceptance');
        }
        if (record.view.candidate.id !== decision.candidateId) throw new Error('candidate mismatch');
        this.transition(record, 'integrating');
        try {
          record.view.integration = await this.deps.integrator.integrate(
            cloneView(record.view), structuredClone(record.view.candidate),
          );
          const attempt = record.view.attempts.find(
            (item) => item.attempt === record.view.candidate?.attempt,
          );
          if (attempt) {
            attempt.outcome = 'accepted';
            attempt.updatedAt = this.now();
          }
          this.transition(record, 'accepted', 'delivery.accepted');
        } catch (error) {
          record.view.error = error instanceof Error ? error.message : String(error);
          this.transition(record, 'failed', 'delivery.failed', record.view.error);
          throw error;
        }
        break;
      }
      case 'return-delivery': {
        if (record.view.status === 'awaiting-delivery-acceptance') {
          if (!decision.candidateId || record.view.candidate?.id !== decision.candidateId) {
            throw new Error('delivery candidate cannot be returned');
          }
          const attempt = record.view.attempts.find(
            (item) => item.attempt === record.view.candidate?.attempt,
          );
          if (attempt) {
            attempt.outcome = 'returned';
            attempt.feedback = decision.feedback;
            attempt.updatedAt = this.now();
          }
        } else if (record.view.status === 'reworking') {
          const attempt = record.view.attempts.find((item) => item.attempt === record.view.attempt);
          if (attempt) {
            attempt.feedback = decision.feedback;
            attempt.updatedAt = this.now();
          }
        } else {
          throw new Error('delivery cannot be scheduled for rework');
        }
        this.transition(record, 'reworking');
        record.view.spec = {
          ...record.view.spec,
          version: record.view.spec.version + 1,
          objective: `${record.view.spec.objective}\n\nRework feedback: ${decision.feedback}`,
        };
        record.view.candidate = undefined;
        record.view.updatedAt = this.now();
        this.append(record, 'delivery.spec-revised', { specVersion: record.view.spec.version });
        break;
      }
      case 'resume-after-interruption':
        if (record.view.status !== 'interrupted') {
          throw new Error('only an interrupted delivery can be resumed');
        }
        record.view.candidate = undefined;
        record.view.error = undefined;
        record.view.updatedAt = this.now();
        this.transition(record, 'reworking', 'delivery.status-changed', {
          recovered: true,
          mode: decision.mode,
        });
        break;
      case 'cancel':
        if (isTerminal(record.view.status)) throw new Error(`cannot cancel ${record.view.status} delivery`);
        record.abort?.abort();
        this.transition(record, 'cancelled');
        break;
    }
    return cloneView(record.view);
  }

  async inspect(id: string): Promise<DeliveryView> { return cloneView(this.require(id).view); }

  async completeCoordinatorReview(
    deliveryId: string,
    session: CoordinatorReviewSession & { reviewHash: string },
  ): Promise<DeliveryView> {
    const record = this.require(deliveryId);
    if (record.view.status === 'awaiting-delivery-acceptance' && record.view.candidate) {
      if (
        record.view.candidate.reviewSession?.id === session.id
        && record.view.candidate.reviewSession.reviewHash === session.reviewHash
      ) {
        return cloneView(record.view);
      }
      throw new Error('a different reviewed candidate already owns this delivery');
    }
    if (record.view.status !== 'coordinator-reviewing') {
      throw new Error(`delivery is not awaiting Coordinator review in ${record.view.status}`);
    }
    if (session.status !== 'completed' || !session.reviewHash) {
      throw new Error('Coordinator review is incomplete');
    }
    const attempt = record.view.attempts.find((item) => item.attempt === session.attempt);
    if (!attempt?.verification) throw new Error('verified delivery attempt is missing');
    if (
      session.deliveryId !== deliveryId
      || session.attempt !== record.view.attempt
      || session.candidate.reportHash !== hashJson(attempt.report)
      || session.candidate.verificationHash !== hashJson(attempt.verification)
    ) {
      throw new Error('Coordinator review does not match the verified delivery attempt');
    }
    const review: ReviewVerdict = {
      passed: true,
      findings: session.reviews.flatMap((item) => item.findings),
    };
    attempt.review = structuredClone(review);
    attempt.outcome = 'awaiting-acceptance';
    attempt.updatedAt = this.now();
    record.view.candidate = {
      id: session.candidate.id,
      attempt: session.attempt,
      report: structuredClone(attempt.report),
      verification: structuredClone(attempt.verification),
      review,
      frozen: structuredClone(session.candidate),
      reviewSession: {
        id: session.id,
        reviewHash: session.reviewHash,
      },
    };
    record.view.error = undefined;
    this.transition(record, 'awaiting-delivery-acceptance');
    return cloneView(record.view);
  }

  async requestCoordinatorRework(
    deliveryId: string,
    session: CoordinatorReviewSession,
  ): Promise<DeliveryView> {
    const record = this.require(deliveryId);
    if (record.view.status !== 'coordinator-reviewing') {
      throw new Error(`delivery is not under Coordinator review in ${record.view.status}`);
    }
    if (session.status !== 'rework-requested' || !session.rework?.findings.length) {
      throw new Error('Coordinator review has no blocking rework request');
    }
    const attempt = record.view.attempts.find((item) => item.attempt === session.attempt);
    if (!attempt) throw new Error('reviewed delivery attempt is missing');
    const review: ReviewVerdict = {
      passed: false,
      findings: structuredClone(session.rework.findings),
    };
    attempt.review = review;
    attempt.outcome = 'review-failed';
    attempt.feedback = session.rework.findings.map((finding) => finding.message).join('\n');
    attempt.updatedAt = this.now();
    record.view.error = 'Coordinator review requested rework';
    record.view.candidate = undefined;
    this.transition(record, 'reworking', 'delivery.status-changed', {
      reason: record.view.error,
      review,
    });
    return cloneView(record.view);
  }

  /**
   * Submit a report produced by the Meeting Scheduler's already-running
   * Worker. The Harness remains the sole owner of verification, review,
   * acceptance and integration without spawning a second agent runtime.
   */
  async submitExternalReport(id: string, report: WorkReport): Promise<DeliveryView> {
    if ((this.deps.executionMode ?? 'internal') !== 'external') {
      throw new Error('delivery harness is not in external execution mode');
    }
    const record = this.require(id);
    if (record.view.status === 'reworking') {
      record.view.attempt += 1;
      this.transition(record, 'executing');
    }
    if (record.view.status !== 'executing') {
      throw new Error(`delivery is not accepting reports in ${record.view.status}`);
    }
    if (record.submittedAttempts.has(record.view.attempt)) {
      throw new Error(`report already submitted for attempt ${record.view.attempt}`);
    }
    record.submittedAttempts.add(record.view.attempt);
    await this.evaluateReport(record, report);
    return cloneView(record.view);
  }

  async *observe(id: string, cursor = 0): AsyncIterable<DeliveryEvent> {
    const record = this.require(id);
    let nextSeq = cursor + 1;
    while (true) {
      const existing = record.events.find((event) => event.seq >= nextSeq);
      if (existing) {
        nextSeq = existing.seq + 1;
        yield structuredClone(existing);
        continue;
      }
      if (isTerminal(record.view.status)) return;
      const event = await new Promise<DeliveryEvent>((resolve) => {
        const listener = (incoming: DeliveryEvent) => {
          if (incoming.seq < nextSeq) return;
          record.subscribers.delete(listener);
          resolve(incoming);
        };
        record.subscribers.add(listener);
      });
      nextSeq = event.seq + 1;
      yield structuredClone(event);
    }
  }

  private async execute(record: DeliveryRecord): Promise<void> {
    const controller = new AbortController();
    record.abort = controller;
    const order = this.toWorkOrder(record.view);
    try {
      this.transition(record, 'executing');
      if (!this.deps.runtime) throw new Error('delivery runtime is required in internal mode');
      const report = await this.deps.runtime.execute(order, controller.signal);
      if (controller.signal.aborted) return;
      await this.evaluateReport(record, report);
    } catch (error) {
      if (controller.signal.aborted || record.view.status === 'cancelled') return;
      record.view.error = error instanceof Error ? error.message : String(error);
      this.transition(record, 'failed', 'delivery.failed', record.view.error);
    } finally {
      if (record.abort === controller) record.abort = undefined;
    }
  }

  private async evaluateReport(record: DeliveryRecord, report: WorkReport): Promise<void> {
    const order = this.toWorkOrder(record.view);
    const attempt: DeliveryAttempt = {
      attempt: record.view.attempt,
      report: structuredClone(report),
      outcome: 'reported',
      updatedAt: this.now(),
    };
    record.view.attempts.push(attempt);
    if (report.status !== 'completed') {
      record.view.error = `worker reported ${report.status}`;
      attempt.outcome = 'worker-incomplete';
      attempt.updatedAt = this.now();
      this.transition(record, 'reworking', 'delivery.status-changed', {
        reason: record.view.error,
        report: structuredClone(report),
      });
      return;
    }

    this.transition(record, 'verifying');
    let verification: VerificationEvidence;
    try {
      verification = await this.deps.verifier.verify(order, report);
    } catch (error) {
      record.view.error = error instanceof Error ? error.message : String(error);
      this.transition(record, 'failed', 'delivery.failed', record.view.error);
      return;
    }
    attempt.verification = structuredClone(verification);
    attempt.updatedAt = this.now();
    if (!verification.passed) {
      record.view.error = verification.error ?? 'verification failed';
      attempt.outcome = 'verification-failed';
      this.transition(record, 'reworking', 'delivery.status-changed', {
        reason: record.view.error,
        verification: structuredClone(verification),
      });
      return;
    }

    this.transition(record, 'reviewing');
    let review: ReviewVerdict;
    try {
      review = await this.deps.reviewer.review(order, report, verification);
    } catch (error) {
      record.view.error = error instanceof Error ? error.message : String(error);
      this.transition(record, 'failed', 'delivery.failed', record.view.error);
      return;
    }
    attempt.review = structuredClone(review);
    attempt.updatedAt = this.now();
    if (!review.passed) {
      record.view.error = 'independent review failed';
      attempt.outcome = 'review-failed';
      this.transition(record, 'reworking', 'delivery.status-changed', {
        reason: record.view.error,
        review: structuredClone(review),
      });
      return;
    }

    if (this.deps.candidatePreparer && this.deps.reviewDriver) {
      let frozen: FrozenDeliveryCandidate;
      try {
        frozen = await this.deps.candidatePreparer.prepare(order, report, verification);
      } catch (error) {
        record.view.error = error instanceof Error ? error.message : String(error);
        attempt.outcome = 'review-failed';
        attempt.updatedAt = this.now();
        this.transition(record, 'reworking', 'delivery.status-changed', {
          reason: record.view.error,
          stage: 'candidate-freeze',
        });
        return;
      }
      this.transition(record, 'coordinator-reviewing');
      const session = await this.deps.reviewDriver.request({
        candidate: frozen,
        verification,
      });
      attempt.outcome = 'coordinator-reviewing';
      attempt.updatedAt = this.now();
      this.append(record, 'delivery.status-changed', {
        reviewId: session.id,
        candidateId: frozen.id,
        commit: frozen.commit,
        diffHash: frozen.diffHash,
      });
      return;
    }

    record.view.error = undefined;
    record.view.candidate = {
      id: this.id(),
      attempt: record.view.attempt,
      report: structuredClone(report),
      verification: structuredClone(verification),
      review: structuredClone(review),
    };
    attempt.outcome = 'awaiting-acceptance';
    attempt.updatedAt = this.now();
    this.transition(record, 'awaiting-delivery-acceptance');
  }

  private toWorkOrder(view: DeliveryView): WorkOrder {
    return {
      deliveryId: view.id,
      ...(view.spec.taskId ? { taskId: view.spec.taskId } : {}),
      attempt: view.attempt,
      meetingId: view.meetingId,
      goal: view.spec.objective,
      acceptanceCriteria: structuredClone(view.spec.acceptanceCriteria),
      workspace: view.workspace,
      sourceRevision: view.sourceRevision,
    };
  }

  private require(id: string): DeliveryRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`delivery not found: ${id}`);
    return record;
  }

  private transition(
    record: DeliveryRecord,
    status: DeliveryStatus,
    type: DeliveryEvent['type'] = 'delivery.status-changed',
    detail?: unknown,
  ): void {
    record.view.status = status;
    record.view.updatedAt = this.now();
    this.append(record, type, detail);
  }

  private append(record: DeliveryRecord, type: DeliveryEvent['type'], detail?: unknown): void {
    const event: DeliveryEvent = {
      deliveryId: record.view.id,
      seq: record.events.length + 1,
      type,
      timestamp: this.now(),
      status: record.view.status,
      detail,
    };
    record.events.push(event);
    for (const subscriber of record.subscribers) subscriber(event);
  }
}

function cloneView(view: DeliveryView): DeliveryView { return structuredClone(view); }

function isTerminal(status: DeliveryStatus): boolean {
  return status === 'accepted' || status === 'failed' || status === 'cancelled';
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
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
