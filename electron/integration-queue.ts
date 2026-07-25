import type {
  DeliveryCandidate,
  DeliveryView,
  VerificationEvidence,
} from './delivery-harness.js';
import {
  GitDeliveryIntegrator,
  type InterruptedIntegrationOperation,
  type IntegrationState,
  type PublishedMeetingIntegration,
  type StagedIntegration,
  type WorkspaceIntegration,
} from './delivery-integrator.js';
import { redactSecrets } from './format-error.js';
import type { PersistedMeetingEvent } from './meeting-repository.js';

export interface IntegrationQueueOptions {
  meetingId: string;
  expectedUserBaseRevision: string;
  integrator: GitDeliveryIntegrator;
  verify: (
    view: DeliveryView,
    candidate: DeliveryCandidate,
    workspace: string,
  ) => Promise<VerificationEvidence>;
  append: (type: string, payload: unknown) => Promise<unknown>;
  flush: () => Promise<void>;
}

export interface MeetingPublicationRequest {
  deliveryId: string;
  contentHash: string;
  integrationHead: string;
  expectedUserBaseRevision: string;
}

export interface IntegrationQueueSnapshot {
  schemaVersion: 1;
  expectedUserBaseRevision: string;
  durableHead?: string;
  state?: IntegrationState;
  accepted: WorkspaceIntegration[];
  activeTaskId?: string;
  interruptedOperation?: InterruptedIntegrationOperation;
  publicationState: 'unpublished' | 'publishing' | 'published' | 'paused';
  publicationRequest?: MeetingPublicationRequest;
  publication?: PublishedMeetingIntegration;
}

export class IntegrationQueue {
  private statePromise?: Promise<IntegrationState>;
  private tail: Promise<unknown> = Promise.resolve();
  private accepted = new Map<string, WorkspaceIntegration>();
  private durableHead?: string;
  private restoredDurableHead?: string;
  private resolvedState?: IntegrationState;
  private activeTaskId?: string;
  private interruptedOperation?: InterruptedIntegrationOperation;
  private publicationState: IntegrationQueueSnapshot['publicationState'] = 'unpublished';
  private publicationRequest?: MeetingPublicationRequest;
  private publication?: PublishedMeetingIntegration;

  constructor(private readonly options: IntegrationQueueOptions) {
    this.durableHead = options.expectedUserBaseRevision;
  }

  currentHead(): string | undefined {
    return this.durableHead;
  }

  /** Restore only durable queue facts. The Git integration worktree remains
   * authoritative for staged-but-unaccepted commits; enqueue() reconciles it
   * against the last journaled durable head through commit trailers. */
  restore(events: PersistedMeetingEvent[]): void {
    if (this.statePromise) {
      throw new Error('integration queue must be restored before it is initialized');
    }
    this.accepted.clear();
    this.restoredDurableHead = undefined;
    this.activeTaskId = undefined;
    this.interruptedOperation = undefined;
    this.publicationState = 'unpublished';
    this.publicationRequest = undefined;
    this.publication = undefined;
    for (const event of events) {
      const taskId = parseTaskId(event.payload);
      if (event.type === 'integration-queued' || event.type === 'integration-staging') {
        if (taskId) this.activeTaskId = taskId;
      }
      if (event.type === 'integration-staged' || event.type === 'integration-verified') {
        const priorHead = parseStagedPriorHead(event.payload);
        if (priorHead) {
          this.restoredDurableHead = priorHead;
          this.durableHead = priorHead;
        }
        continue;
      }
      if (event.type === 'integration-accepted') {
        const fact = parseIntegrationFact(event.payload);
        if (!fact?.integration || !fact.durableHead) continue;
        this.restoredDurableHead = fact.durableHead;
        this.durableHead = fact.durableHead;
        this.activeTaskId = undefined;
        if (fact.key) this.accepted.set(fact.key, structuredClone(fact.integration));
        continue;
      }
      if (event.type === 'integration-failed') {
        this.activeTaskId = undefined;
        continue;
      }
      if (event.type === 'meeting-publication-started') {
        const request = parsePublicationRequest(event.payload);
        if (request) {
          this.publicationState = 'publishing';
          this.publicationRequest = request;
        }
        continue;
      }
      if (event.type === 'meeting-publication-completed') {
        const publication = parsePublicationResult(event.payload);
        if (publication) {
          this.publicationState = 'published';
          this.publication = publication;
        }
        continue;
      }
      if (event.type === 'meeting-publication-paused') {
        this.publicationState = 'paused';
      }
    }
  }

  async inspectState(): Promise<IntegrationState> {
    return structuredClone(await this.state());
  }

  async detectInterruptedOperation(): Promise<InterruptedIntegrationOperation | null> {
    if (!this.activeTaskId) return null;
    const state = await this.state();
    this.interruptedOperation = (
      await this.options.integrator.inspectInterruptedOperation(state)
    ) ?? undefined;
    return this.interruptedOperation
      ? structuredClone(this.interruptedOperation)
      : null;
  }

  async resolveInterruptedOperation(
    taskId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.activeTaskId || this.activeTaskId !== taskId) {
      return { ok: false, error: 'interrupted integration task does not match' };
    }
    const state = await this.state();
    const operation = this.interruptedOperation
      ?? await this.options.integrator.inspectInterruptedOperation(state);
    if (!operation) return { ok: false, error: 'no interrupted queue-owned integration exists' };
    try {
      await this.options.integrator.abortInterruptedOperation(state, operation);
      this.interruptedOperation = undefined;
      this.activeTaskId = undefined;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  snapshot(): IntegrationQueueSnapshot {
    return {
      schemaVersion: 1,
      expectedUserBaseRevision: this.options.expectedUserBaseRevision,
      ...(this.durableHead ? { durableHead: this.durableHead } : {}),
      ...(this.resolvedState ? { state: structuredClone(this.resolvedState) } : {}),
      accepted: [...this.accepted.values()].map((entry) => structuredClone(entry)),
      ...(this.activeTaskId ? { activeTaskId: this.activeTaskId } : {}),
      ...(this.interruptedOperation
        ? { interruptedOperation: structuredClone(this.interruptedOperation) }
        : {}),
      publicationState: this.publicationState,
      ...(this.publicationRequest
        ? { publicationRequest: structuredClone(this.publicationRequest) }
        : {}),
      ...(this.publication ? { publication: structuredClone(this.publication) } : {}),
    };
  }

  enqueue(view: DeliveryView, candidate: DeliveryCandidate): Promise<WorkspaceIntegration> {
    const key = candidate.frozen
      ? `${view.id}:${candidate.attempt}:${candidate.frozen.commit}:${candidate.reviewSession?.reviewHash ?? ''}`
      : `${view.id}:${candidate.attempt}:legacy`;
    const existing = this.accepted.get(key);
    if (existing) return Promise.resolve(structuredClone(existing));
    const operation = this.tail.then(() => this.process(key, view, candidate));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  publishFinalDelivery(
    request: MeetingPublicationRequest,
  ): Promise<PublishedMeetingIntegration> {
    const operation = this.tail.then(() => this.publish(request));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async cleanupPublishedIntegration(publishedHead: string): Promise<void> {
    const state = await this.state();
    this.options.integrator.cleanupPublishedIntegration(state, publishedHead);
  }

  private async process(
    key: string,
    view: DeliveryView,
    candidate: DeliveryCandidate,
  ): Promise<WorkspaceIntegration> {
    const duplicate = this.accepted.get(key);
    if (duplicate) return structuredClone(duplicate);
    const state = await this.state();
    this.activeTaskId = view.spec.taskId ?? view.id;
    await this.persist('integration-queued', view, candidate, { integrationHead: state.durableHead });
    let staged: StagedIntegration | undefined;
    try {
      await this.persist('integration-staging', view, candidate, {
        integrationHead: state.durableHead,
        branch: state.branch,
        workspace: state.workspace,
      });
      staged = await this.options.integrator.stageCandidate(view, candidate, state);
      await this.persist('integration-staged', view, candidate, { staged });
      const verified = await this.options.integrator.verifyStagedIntegration(
        staged,
        (workspace) => this.options.verify(view, candidate, workspace),
      );
      await this.persist('integration-verified', view, candidate, { verified });
      const integration = await this.options.integrator.acceptVerifiedIntegration(verified, state);
      await this.persist('integration-accepted', view, candidate, {
        integration,
        durableHead: verified.resultingIntegrationHead,
      });
      state.durableHead = verified.resultingIntegrationHead;
      this.durableHead = state.durableHead;
      this.resolvedState = structuredClone(state);
      this.accepted.set(key, structuredClone(integration));
      this.activeTaskId = undefined;
      return integration;
    } catch (error) {
      if (staged) {
        await this.options.integrator.abortStagedIntegration(staged).catch(() => undefined);
      }
      await this.persist('integration-failed', view, candidate, {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'integration-failed',
        message: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        priorIntegrationHead: state.durableHead,
      });
      this.activeTaskId = undefined;
      throw error;
    }
  }

  private async publish(
    request: MeetingPublicationRequest,
  ): Promise<PublishedMeetingIntegration> {
    if (
      !request.deliveryId
      || !/^[0-9a-f]{64}$/u.test(request.contentHash)
      || !/^[0-9a-f]{40,64}$/u.test(request.integrationHead)
    ) {
      throw new Error('Meeting publication request is invalid');
    }
    const state = await this.state();
    if (
      state.durableHead !== request.integrationHead
      || this.durableHead !== request.integrationHead
    ) {
      throw new Error('Meeting publication does not match the durable integration head');
    }
    await this.persistMeeting('meeting-publication-started', request, {
      durableHead: state.durableHead,
      branch: state.branch,
      workspace: state.workspace,
    });
    this.publicationState = 'publishing';
    this.publicationRequest = structuredClone(request);
    try {
      const publication = await this.options.integrator.publishUserBase(
        state,
        request.expectedUserBaseRevision,
        request.integrationHead,
      );
      await this.persistMeeting('meeting-publication-completed', request, { publication });
      this.publicationState = 'published';
      this.publication = structuredClone(publication);
      return publication;
    } catch (error) {
      await this.persistMeeting('meeting-publication-paused', request, {
        code: error instanceof Error && 'code' in error ? String(error.code) : 'publication-failed',
        message: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      });
      this.publicationState = 'paused';
      throw error;
    }
  }

  private state(): Promise<IntegrationState> {
    if (!this.statePromise) {
      this.statePromise = this.options.integrator.initialize(
        this.options.expectedUserBaseRevision,
      ).then((state) => {
        if (this.restoredDurableHead) state.durableHead = this.restoredDurableHead;
        this.durableHead = state.durableHead;
        this.resolvedState = structuredClone(state);
        return state;
      });
    }
    return this.statePromise;
  }

  private async persist(
    type: string,
    view: DeliveryView,
    candidate: DeliveryCandidate,
    data: unknown,
  ): Promise<void> {
    await this.options.append(type, {
      schemaVersion: 1,
      taskId: view.spec.taskId ?? view.id,
      deliveryId: view.id,
      attempt: candidate.attempt,
      candidateId: candidate.id,
      candidateCommit: candidate.frozen?.commit,
      reviewHash: candidate.reviewSession?.reviewHash,
      data,
    });
    await this.options.flush();
  }

  private async persistMeeting(
    type: string,
    request: MeetingPublicationRequest,
    data: unknown,
  ): Promise<void> {
    await this.options.append(type, {
      schemaVersion: 1,
      taskId: 'meeting-publication',
      deliveryId: request.deliveryId,
      contentHash: request.contentHash,
      integrationHead: request.integrationHead,
      expectedUserBaseRevision: request.expectedUserBaseRevision,
      data,
    });
    await this.options.flush();
  }
}

function parseStagedPriorHead(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const envelope = payload as Record<string, unknown>;
  const fact = envelope.data;
  if (!fact || typeof fact !== 'object') return undefined;
  const detail = (fact as Record<string, unknown>).data;
  if (!detail || typeof detail !== 'object') return undefined;
  const staged = (detail as Record<string, unknown>).staged
    ?? (detail as Record<string, unknown>).verified;
  if (!staged || typeof staged !== 'object') return undefined;
  const prior = (staged as Record<string, unknown>).priorIntegrationHead;
  return typeof prior === 'string' && prior ? prior : undefined;
}

function parseIntegrationFact(payload: unknown): {
  key?: string;
  durableHead?: string;
  integration?: WorkspaceIntegration;
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as Record<string, unknown>;
  const fact = envelope.data;
  if (!fact || typeof fact !== 'object') return null;
  const record = fact as Record<string, unknown>;
  const detail = record.data;
  if (!detail || typeof detail !== 'object') return null;
  const accepted = detail as Record<string, unknown>;
  const integration = accepted.integration;
  const durableHead = typeof accepted.durableHead === 'string'
    ? accepted.durableHead
    : undefined;
  if (!integration || typeof integration !== 'object') {
    return durableHead ? { durableHead } : null;
  }
  const deliveryId = typeof record.deliveryId === 'string' ? record.deliveryId : '';
  const attempt = Number(record.attempt);
  const candidateCommit = typeof record.candidateCommit === 'string'
    ? record.candidateCommit
    : '';
  const reviewHash = typeof record.reviewHash === 'string' ? record.reviewHash : '';
  const key = deliveryId && Number.isSafeInteger(attempt) && attempt > 0
    ? `${deliveryId}:${attempt}:${candidateCommit || 'legacy'}${candidateCommit ? `:${reviewHash}` : ''}`
    : undefined;
  return {
    ...(key ? { key } : {}),
    ...(durableHead ? { durableHead } : {}),
    integration: structuredClone(integration as WorkspaceIntegration),
  };
}

function parseTaskId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const outer = payload as Record<string, unknown>;
  if (typeof outer.taskId === 'string' && outer.taskId) return outer.taskId;
  const data = outer.data;
  if (!data || typeof data !== 'object') return undefined;
  const inner = data as Record<string, unknown>;
  return typeof inner.taskId === 'string' && inner.taskId
    ? inner.taskId
    : undefined;
}

function parsePublicationRequest(payload: unknown): MeetingPublicationRequest | null {
  if (!payload || typeof payload !== 'object') return null;
  const outer = payload as Record<string, unknown>;
  const data = outer.data;
  const nested = data && typeof data === 'object'
    ? data as Record<string, unknown>
    : null;
  const candidate = typeof outer.contentHash === 'string'
    ? outer
    : nested ?? outer;
  const deliveryId = candidate.deliveryId;
  const contentHash = candidate.contentHash;
  const integrationHead = candidate.integrationHead;
  const expectedUserBaseRevision = candidate.expectedUserBaseRevision;
  return (
    typeof deliveryId === 'string'
    && typeof contentHash === 'string'
    && /^[0-9a-f]{64}$/u.test(contentHash)
    && typeof integrationHead === 'string'
    && /^[0-9a-f]{40,64}$/u.test(integrationHead)
    && typeof expectedUserBaseRevision === 'string'
  ) ? {
      deliveryId,
      contentHash,
      integrationHead,
      expectedUserBaseRevision,
    } : null;
}

function parsePublicationResult(payload: unknown): PublishedMeetingIntegration | null {
  if (!payload || typeof payload !== 'object') return null;
  const outer = payload as Record<string, unknown>;
  const first = outer.data;
  if (!first || typeof first !== 'object') return null;
  const firstRecord = first as Record<string, unknown>;
  const second = firstRecord.data;
  const detail = second && typeof second === 'object'
    ? second as Record<string, unknown>
    : firstRecord;
  const publication = detail.publication;
  if (!publication || typeof publication !== 'object') return null;
  const result = publication as Record<string, unknown>;
  if (
    result.schemaVersion !== 1
    || typeof result.expectedUserBaseRevision !== 'string'
    || typeof result.integrationHead !== 'string'
    || typeof result.publishedHead !== 'string'
    || typeof result.alreadyPublished !== 'boolean'
  ) return null;
  return structuredClone(publication as PublishedMeetingIntegration);
}
