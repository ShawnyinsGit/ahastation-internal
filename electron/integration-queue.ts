import type {
  DeliveryCandidate,
  DeliveryView,
  VerificationEvidence,
} from './delivery-harness.js';
import {
  GitDeliveryIntegrator,
  type IntegrationState,
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

export class IntegrationQueue {
  private statePromise?: Promise<IntegrationState>;
  private tail: Promise<unknown> = Promise.resolve();
  private accepted = new Map<string, WorkspaceIntegration>();
  private durableHead?: string;
  private restoredDurableHead?: string;

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
    for (const event of events) {
      if (event.type === 'integration-staged' || event.type === 'integration-verified') {
        const priorHead = parseStagedPriorHead(event.payload);
        if (priorHead) {
          this.restoredDurableHead = priorHead;
          this.durableHead = priorHead;
        }
        continue;
      }
      if (event.type !== 'integration-accepted') continue;
      const fact = parseIntegrationFact(event.payload);
      if (!fact?.integration || !fact.durableHead) continue;
      this.restoredDurableHead = fact.durableHead;
      this.durableHead = fact.durableHead;
      if (fact.key) this.accepted.set(fact.key, structuredClone(fact.integration));
    }
  }

  async inspectState(): Promise<IntegrationState> {
    return structuredClone(await this.state());
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

  private async process(
    key: string,
    view: DeliveryView,
    candidate: DeliveryCandidate,
  ): Promise<WorkspaceIntegration> {
    const duplicate = this.accepted.get(key);
    if (duplicate) return structuredClone(duplicate);
    const state = await this.state();
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
      this.accepted.set(key, structuredClone(integration));
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
