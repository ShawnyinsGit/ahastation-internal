import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  buildDeliveryDiffManifest,
  type DeliveryDiffManifest,
} from './delivery-diff.js';
import type {
  VerificationEvidence,
  WorkOrder,
} from './delivery-harness.js';
import type { WorkReport } from './worker-protocol.js';

const execFileAsync = promisify(execFile);
const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;

export interface FrozenDeliveryCandidate {
  schemaVersion: 1;
  id: string;
  deliveryId: string;
  taskId?: string;
  attempt: number;
  workspace: string;
  baseRevision: string;
  commit: string;
  tree: string;
  reportHash: string;
  verificationHash: string;
  diffHash: string;
  reportedPaths: string[];
  createdAt: number;
  manifest: DeliveryDiffManifest;
}

export interface PrepareFrozenDeliveryCandidateInput {
  order: WorkOrder;
  report: WorkReport;
  verification: VerificationEvidence;
  now?: () => number;
  id?: () => string;
}

/**
 * Re-open an unaccepted immutable candidate for a fresh rework attempt.
 *
 * Candidate commits are coordinator-owned snapshots, not Worker-authored
 * history. Rework must therefore move the task branch back to the original
 * base while preserving the candidate tree as unstaged workspace changes.
 * The next candidate then remains one exact commit that IntegrationQueue can
 * cherry-pick without depending on an earlier rejected candidate.
 */
export async function reopenFrozenDeliveryCandidateForRework(
  candidate: FrozenDeliveryCandidate,
): Promise<void> {
  const workspace = resolve(candidate.workspace);
  const head = await git(workspace, ['rev-parse', 'HEAD']);
  if (head !== candidate.commit) {
    throw new Error(
      `cannot reopen candidate ${candidate.id}; task HEAD is ${head}, expected ${candidate.commit}`,
    );
  }
  const remaining = await changedWorkspacePaths(workspace);
  if (remaining.length > 0) {
    throw new Error(
      `cannot reopen candidate ${candidate.id}; worktree is not clean: ${remaining.join(', ')}`,
    );
  }
  const parent = await git(workspace, ['rev-parse', `${candidate.commit}^`]);
  if (parent !== candidate.baseRevision) {
    throw new Error(
      `cannot reopen candidate ${candidate.id}; parent ${parent} does not match ${candidate.baseRevision}`,
    );
  }

  await git(workspace, ['reset', '--mixed', candidate.baseRevision]);
  const reopenedHead = await git(workspace, ['rev-parse', 'HEAD']);
  if (reopenedHead !== candidate.baseRevision) {
    throw new Error(
      `candidate ${candidate.id} reopened at ${reopenedHead}, expected ${candidate.baseRevision}`,
    );
  }
  const reopenedPaths = await changedWorkspacePaths(workspace);
  if (
    reopenedPaths.length !== candidate.reportedPaths.length
    || reopenedPaths.some((path, index) => path !== candidate.reportedPaths[index])
  ) {
    throw new Error(
      `candidate ${candidate.id} reopened with unexpected paths: ${reopenedPaths.join(', ')}`,
    );
  }
}

export async function prepareFrozenDeliveryCandidate(
  input: PrepareFrozenDeliveryCandidateInput,
): Promise<FrozenDeliveryCandidate> {
  const now = input.now ?? Date.now;
  const workspace = resolve(input.order.workspace);
  const reportHash = sha256(stableStringify(input.report));
  const verificationHash = sha256(stableStringify(input.verification));
  const reportedPaths = [...new Set(
    input.report.files.map((file) => normalizeRelativePath(workspace, file.path)),
  )].sort();
  const head = await git(workspace, ['rev-parse', 'HEAD']);
  if (head !== input.order.sourceRevision) {
    const existing = await existingCandidate(
      workspace,
      input.order,
      input.report,
      input.verification,
      reportHash,
      verificationHash,
      reportedPaths,
      now,
    );
    if (existing) return existing;
    throw new Error(
      `task candidate HEAD moved from ${input.order.sourceRevision} to ${head}`,
    );
  }

  const dirtyPaths = await changedWorkspacePaths(workspace);
  const unreported = dirtyPaths.filter((path) => !reportedPaths.includes(path));
  const unchangedReported = reportedPaths.filter((path) => !dirtyPaths.includes(path));
  if (unreported.length > 0) {
    throw new Error(`worktree contains unreported changes: ${unreported.join(', ')}`);
  }
  if (unchangedReported.length > 0) {
    throw new Error(`WorkReport contains unchanged paths: ${unchangedReported.join(', ')}`);
  }

  if (reportedPaths.length > 0) {
    await git(workspace, ['add', '--', ...reportedPaths]);
  }
  const stagedPaths = await stagedWorkspacePaths(workspace);
  const stagedUnreported = stagedPaths.filter((path) => !reportedPaths.includes(path));
  const missingStaged = reportedPaths.filter((path) => !stagedPaths.includes(path));
  if (stagedUnreported.length > 0 || missingStaged.length > 0) {
    throw new Error(
      `candidate staging mismatch; unreported=[${stagedUnreported.join(', ')}] missing=[${missingStaged.join(', ')}]`,
    );
  }

  const commitMessage = [
    `AhaStation task candidate ${input.order.taskId ?? input.order.deliveryId}`,
    '',
    `AhaStation-Delivery-Id: ${input.order.deliveryId}`,
    `AhaStation-Attempt: ${input.order.attempt}`,
    `AhaStation-Report-Hash: ${reportHash}`,
    `AhaStation-Verification-Hash: ${verificationHash}`,
  ].join('\n');
  await git(workspace, [
    '-c',
    'user.name=AhaStation Coordinator',
    '-c',
    'user.email=coordinator@ahastation.local',
    'commit',
    '--allow-empty',
    '-m',
    commitMessage,
    '--',
    ...reportedPaths,
  ]);
  const commit = await git(workspace, ['rev-parse', 'HEAD']);
  const tree = await git(workspace, ['rev-parse', 'HEAD^{tree}']);
  const manifest = await buildDeliveryDiffManifest({
    workspace,
    baseRevision: input.order.sourceRevision,
    candidateRevision: commit,
    paths: reportedPaths,
  });
  if (manifest.files.length !== reportedPaths.length) {
    throw new Error('frozen diff manifest does not cover every reported path');
  }
  const remaining = await changedWorkspacePaths(workspace);
  if (remaining.length > 0) {
    throw new Error(`worktree changed while freezing candidate: ${remaining.join(', ')}`);
  }
  return {
    schemaVersion: 1,
    id: stableCandidateId(input.id, input.order.deliveryId, commit, reportHash),
    deliveryId: input.order.deliveryId,
    ...(input.order.taskId ? { taskId: input.order.taskId } : {}),
    attempt: input.order.attempt,
    workspace,
    baseRevision: input.order.sourceRevision,
    commit,
    tree,
    reportHash,
    verificationHash,
    diffHash: manifest.diffHash,
    reportedPaths,
    createdAt: now(),
    manifest,
  };
}

async function existingCandidate(
  workspace: string,
  order: WorkOrder,
  report: WorkReport,
  verification: VerificationEvidence,
  reportHash: string,
  verificationHash: string,
  reportedPaths: string[],
  now: () => number,
): Promise<FrozenDeliveryCandidate | null> {
  if ((await changedWorkspacePaths(workspace)).length > 0) return null;
  const body = await git(workspace, ['log', '-1', '--format=%B']);
  if (
    !body.includes(`AhaStation-Delivery-Id: ${order.deliveryId}`)
    || !body.includes(`AhaStation-Attempt: ${order.attempt}`)
    || !body.includes(`AhaStation-Report-Hash: ${reportHash}`)
    || !body.includes(`AhaStation-Verification-Hash: ${verificationHash}`)
  ) {
    return null;
  }
  const commit = await git(workspace, ['rev-parse', 'HEAD']);
  const parent = await git(workspace, ['rev-parse', 'HEAD^']);
  if (parent !== order.sourceRevision) return null;
  const tree = await git(workspace, ['rev-parse', 'HEAD^{tree}']);
  const manifest = await buildDeliveryDiffManifest({
    workspace,
    baseRevision: order.sourceRevision,
    candidateRevision: commit,
    paths: reportedPaths,
  });
  if (manifest.files.length !== reportedPaths.length) return null;
  // The hashes bind the immutable report and verification even though the
  // caller supplies their structured values again during crash recovery.
  void report;
  void verification;
  return {
    schemaVersion: 1,
    id: stableCandidateId(undefined, order.deliveryId, commit, reportHash),
    deliveryId: order.deliveryId,
    ...(order.taskId ? { taskId: order.taskId } : {}),
    attempt: order.attempt,
    workspace,
    baseRevision: order.sourceRevision,
    commit,
    tree,
    reportHash,
    verificationHash,
    diffHash: manifest.diffHash,
    reportedPaths,
    createdAt: now(),
    manifest,
  };
}

async function changedWorkspacePaths(workspace: string): Promise<string[]> {
  const tracked = await git(workspace, [
    'diff',
    '--name-only',
    '--no-renames',
    'HEAD',
    '--',
  ]);
  const staged = await git(workspace, [
    'diff',
    '--cached',
    '--name-only',
    '--no-renames',
    'HEAD',
    '--',
  ]);
  const untracked = await git(workspace, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
  ]);
  return [...new Set(
    [tracked, staged, untracked]
      .flatMap((output) => output.split(/\r?\n/u))
      .map((path) => path.trim())
      .filter(Boolean),
  )].sort();
}

async function stagedWorkspacePaths(workspace: string): Promise<string[]> {
  return (
    await git(workspace, [
      'diff',
      '--cached',
      '--name-only',
      '--no-renames',
      'HEAD',
      '--',
    ])
  ).split(/\r?\n/u).map((path) => path.trim()).filter(Boolean).sort();
}

function normalizeRelativePath(workspace: string, path: string): string {
  if (!path || path.includes('\0')) throw new Error('reported path is invalid');
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workspace, path);
  const normalized = relative(workspace, absolute).split(sep).join('/');
  if (
    !normalized
    || normalized === '..'
    || normalized.startsWith('../')
    || isAbsolute(normalized)
  ) {
    throw new Error(`reported path escapes workspace: ${path}`);
  }
  return normalized;
}

function stableCandidateId(
  id: (() => string) | undefined,
  deliveryId: string,
  commit: string,
  reportHash: string,
): string {
  const deterministic = sha256(`${deliveryId}\0${commit}\0${reportHash}`);
  return id?.() ?? `candidate-${deterministic.slice(0, 24)}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_LIMIT,
    windowsHide: true,
  });
  return stdout.trim();
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
