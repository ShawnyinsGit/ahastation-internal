import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  DeliveryCandidate,
  DeliveryView,
  VerificationEvidence,
} from './delivery-harness.js';
import { buildDeliveryDiffManifest } from './delivery-diff.js';

const execFileAsync = promisify(execFile);

export interface IntegrationState {
  schemaVersion: 1;
  meetingId: string;
  expectedUserBaseRevision: string;
  durableHead: string;
  branch: string;
  workspace: string;
}

export interface StagedIntegration {
  schemaVersion: 1;
  deliveryId: string;
  taskId?: string;
  candidateId: string;
  candidateCommit: string;
  candidateTree: string;
  reviewHash: string;
  priorIntegrationHead: string;
  resultingIntegrationHead: string;
  resultingTree: string;
  workspace: string;
  branch: string;
}

export interface VerifiedIntegration extends StagedIntegration {
  verification: VerificationEvidence;
}

export interface WorkspaceIntegration {
  [key: string]: unknown;
  kind: 'meeting-branch' | 'git-worktree' | 'shared-locked';
  sourceRevision: string;
  resultRevision?: string;
  workspace: string;
  branch?: string;
  candidateCommit?: string;
  reviewHash?: string;
}

export class IntegrationConflictError extends Error {
  readonly code = 'integration-conflict' as const;
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationConflictError';
  }
}

/** Git mechanics for the queue-owned Meeting integration worktree. It never
 * runs mutating Git commands in the user's base worktree. */
export class GitDeliveryIntegrator {
  constructor(
    private readonly baseCwd: string,
    private readonly meetingId: string,
    private readonly worktreeRoot: string,
  ) {}

  async initialize(expectedUserBaseRevision: string): Promise<IntegrationState> {
    const expected = await git(this.baseCwd, ['rev-parse', '--verify', `${expectedUserBaseRevision}^{commit}`]);
    const branch = `ahastation/integration/${safeSegment(this.meetingId)}`;
    const workspace = resolve(this.worktreeRoot, safeSegment(this.meetingId));
    if (!existsSync(workspace)) {
      mkdirSync(dirname(workspace), { recursive: true });
      const branchExists = await gitExitOk(this.baseCwd, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
      await git(this.baseCwd, [
        'worktree',
        'add',
        ...(branchExists ? [] : ['-b', branch]),
        workspace,
        branchExists ? branch : expected,
      ]);
    }
    const durableHead = await git(workspace, ['rev-parse', 'HEAD']);
    const actualBranch = await git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (actualBranch !== branch) {
      throw new Error(`Meeting integration workspace is attached to unexpected branch ${actualBranch}`);
    }
    if (!await gitExitOk(workspace, ['merge-base', '--is-ancestor', expected, durableHead])) {
      throw new Error('Meeting integration branch no longer descends from the expected user base');
    }
    return {
      schemaVersion: 1,
      meetingId: this.meetingId,
      expectedUserBaseRevision: expected,
      durableHead,
      branch,
      workspace,
    };
  }

  async stageCandidate(
    view: DeliveryView,
    candidate: DeliveryCandidate,
    state: IntegrationState,
  ): Promise<StagedIntegration> {
    const frozen = candidate.frozen;
    const reviewHash = candidate.reviewSession?.reviewHash;
    if (!frozen || !reviewHash) throw new Error('integration requires a frozen reviewed candidate');
    if (
      candidate.id !== frozen.id
      || !candidate.review.passed
      || frozen.reportHash !== sha256(stableStringify(candidate.report))
      || frozen.verificationHash !== sha256(stableStringify(candidate.verification))
      || frozen.diffHash !== frozen.manifest.diffHash
    ) {
      throw new Error('reviewed candidate evidence hashes no longer match');
    }
    if (frozen.deliveryId !== view.id || frozen.attempt !== view.attempt) {
      throw new Error('reviewed candidate does not match the delivery attempt');
    }
    const candidateCommit = await git(frozen.workspace, ['rev-parse', '--verify', `${frozen.commit}^{commit}`]);
    const candidateTree = await git(frozen.workspace, ['rev-parse', `${candidateCommit}^{tree}`]);
    if (candidateCommit !== frozen.commit || candidateTree !== frozen.tree) {
      throw new Error('reviewed candidate commit or tree changed');
    }
    const candidateParent = await git(frozen.workspace, ['rev-parse', `${candidateCommit}^`]);
    const candidateBody = await git(frozen.workspace, ['log', '-1', '--format=%B', candidateCommit]);
    const rebuiltManifest = await buildDeliveryDiffManifest({
      workspace: frozen.workspace,
      baseRevision: frozen.baseRevision,
      candidateRevision: candidateCommit,
      paths: frozen.reportedPaths,
    });
    if (
      candidateParent !== frozen.baseRevision
      || !candidateBody.includes(`AhaStation-Delivery-Id: ${frozen.deliveryId}`)
      || !candidateBody.includes(`AhaStation-Attempt: ${frozen.attempt}`)
      || !candidateBody.includes(`AhaStation-Report-Hash: ${frozen.reportHash}`)
      || !candidateBody.includes(`AhaStation-Verification-Hash: ${frozen.verificationHash}`)
      || rebuiltManifest.diffHash !== frozen.diffHash
    ) {
      throw new Error('frozen candidate Git evidence no longer matches its reviewed manifest');
    }
    const integrationHead = await git(state.workspace, ['rev-parse', 'HEAD']);
    if (integrationHead !== state.durableHead) {
      const recovered = await recoverStaged(state, view.id, candidateCommit, reviewHash);
      if (recovered) {
        return {
          ...recovered,
          ...(view.spec.taskId ? { taskId: view.spec.taskId } : {}),
          candidateId: candidate.id,
          candidateTree,
        };
      }
      throw new Error(`integration HEAD moved from ${state.durableHead} to ${integrationHead}`);
    }
    try {
      await git(state.workspace, ['cherry-pick', candidateCommit]);
    } catch (error) {
      if (await gitExitOk(state.workspace, ['rev-parse', '--verify', '-q', 'CHERRY_PICK_HEAD'])) {
        await git(state.workspace, ['cherry-pick', '--abort']);
      }
      throw new IntegrationConflictError(
        `candidate ${candidateCommit} conflicts with Meeting integration head ${state.durableHead}: ${safeError(error)}`,
      );
    }
    const resultingIntegrationHead = await git(state.workspace, ['rev-parse', 'HEAD']);
    const resultingTree = await git(state.workspace, ['rev-parse', 'HEAD^{tree}']);
    await appendCommitTrailers(state.workspace, view.id, candidateCommit, reviewHash);
    const finalHead = await git(state.workspace, ['rev-parse', 'HEAD']);
    const finalTree = await git(state.workspace, ['rev-parse', 'HEAD^{tree}']);
    return {
      schemaVersion: 1,
      deliveryId: view.id,
      ...(view.spec.taskId ? { taskId: view.spec.taskId } : {}),
      candidateId: candidate.id,
      candidateCommit,
      candidateTree,
      reviewHash,
      priorIntegrationHead: state.durableHead,
      resultingIntegrationHead: finalHead || resultingIntegrationHead,
      resultingTree: finalTree || resultingTree,
      workspace: state.workspace,
      branch: state.branch,
    };
  }

  async verifyStagedIntegration(
    staged: StagedIntegration,
    verify: (workspace: string) => Promise<VerificationEvidence>,
  ): Promise<VerifiedIntegration> {
    const head = await git(staged.workspace, ['rev-parse', 'HEAD']);
    const tree = await git(staged.workspace, ['rev-parse', 'HEAD^{tree}']);
    if (head !== staged.resultingIntegrationHead || tree !== staged.resultingTree) {
      throw new Error('staged integration changed before verification');
    }
    const verification = await verify(staged.workspace);
    if (!verification.passed) {
      throw new Error(verification.error ?? 'post-integration verification failed');
    }
    return { ...staged, verification: structuredClone(verification) };
  }

  async acceptVerifiedIntegration(
    verified: VerifiedIntegration,
    state: IntegrationState,
  ): Promise<WorkspaceIntegration> {
    if (verified.priorIntegrationHead !== state.durableHead) {
      throw new Error('durable integration head changed before acceptance');
    }
    const head = await git(state.workspace, ['rev-parse', 'HEAD']);
    const tree = await git(state.workspace, ['rev-parse', 'HEAD^{tree}']);
    if (head !== verified.resultingIntegrationHead || tree !== verified.resultingTree) {
      throw new Error('verified integration evidence no longer matches HEAD');
    }
    return {
      kind: 'meeting-branch',
      sourceRevision: verified.priorIntegrationHead,
      resultRevision: verified.resultingIntegrationHead,
      workspace: state.workspace,
      branch: state.branch,
      candidateCommit: verified.candidateCommit,
      reviewHash: verified.reviewHash,
    };
  }

  async abortStagedIntegration(staged: StagedIntegration): Promise<void> {
    const head = await git(staged.workspace, ['rev-parse', 'HEAD']);
    if (head === staged.priorIntegrationHead) return;
    if (head !== staged.resultingIntegrationHead) {
      throw new Error('refusing to abort an integration worktree that moved unexpectedly');
    }
    await git(staged.workspace, ['reset', '--hard', staged.priorIntegrationHead]);
  }
}

/** Legacy direct-base integrator retained only for old persisted deliveries.
 * New reviewed candidates are always routed through IntegrationQueue. */
export class WorkspaceDeliveryIntegrator {
  constructor(private readonly baseCwd: string) {}

  async integrate(view: DeliveryView): Promise<WorkspaceIntegration> {
    if (view.sourceRevision === 'non-git') {
      return { kind: 'shared-locked', sourceRevision: 'non-git', workspace: view.workspace };
    }
    throw new Error(
      `legacy direct-base integration is disabled for ${view.id}; use the Meeting integration queue rooted at ${this.baseCwd}`,
    );
  }
}

async function recoverStaged(
  state: IntegrationState,
  deliveryId: string,
  candidateCommit: string,
  reviewHash: string,
): Promise<StagedIntegration | null> {
  const body = await git(state.workspace, ['log', '-1', '--format=%B']);
  if (
    !body.includes(`AhaStation-Delivery-Id: ${deliveryId}`)
    || !body.includes(`AhaStation-Candidate-Commit: ${candidateCommit}`)
    || !body.includes(`AhaStation-Review-Hash: ${reviewHash}`)
  ) return null;
  const resultingIntegrationHead = await git(state.workspace, ['rev-parse', 'HEAD']);
  const priorIntegrationHead = await git(state.workspace, ['rev-parse', 'HEAD^']);
  if (priorIntegrationHead !== state.durableHead) return null;
  return {
    schemaVersion: 1,
    deliveryId,
    candidateId: '',
    candidateCommit,
    candidateTree: await git(state.workspace, ['rev-parse', `${candidateCommit}^{tree}`]),
    reviewHash,
    priorIntegrationHead,
    resultingIntegrationHead,
    resultingTree: await git(state.workspace, ['rev-parse', 'HEAD^{tree}']),
    workspace: state.workspace,
    branch: state.branch,
  };
}

async function appendCommitTrailers(
  cwd: string,
  deliveryId: string,
  candidateCommit: string,
  reviewHash: string,
): Promise<void> {
  const body = await git(cwd, ['log', '-1', '--format=%B']);
  if (
    body.includes(`AhaStation-Delivery-Id: ${deliveryId}`)
    && body.includes(`AhaStation-Candidate-Commit: ${candidateCommit}`)
    && body.includes(`AhaStation-Review-Hash: ${reviewHash}`)
  ) return;
  const message = [
    body.trimEnd(),
    '',
    `AhaStation-Delivery-Id: ${deliveryId}`,
    `AhaStation-Candidate-Commit: ${candidateCommit}`,
    `AhaStation-Review-Hash: ${reviewHash}`,
  ].join('\n');
  await git(cwd, [
    '-c', 'user.name=AhaStation Integrator',
    '-c', 'user.email=integrator@ahastation.local',
    'commit', '--amend', '-m', message,
  ]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}

async function gitExitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'meeting';
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(token|authorization|credential|secret)\s*[:=]\s*\S+/giu, '$1=[REDACTED]')
    .slice(0, 2_000);
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
