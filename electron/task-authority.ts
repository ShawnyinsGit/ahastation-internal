import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import type { CanonicalExecutionRequest } from './backends/canonical-execution.js';
import {
  taskAuthorityGrantSchema,
  type TaskAuthorityGrant,
} from './task-collaboration.js';
import type { PlanMeetingTask } from './meeting-tools.js';

export const DEFAULT_TASK_AUTHORITY_TTL_MS = 24 * 60 * 60 * 1_000;

export type AuthorityDecision =
  | { kind: 'allow'; reason: string }
  | { kind: 'ask-user'; reason: string }
  | { kind: 'deny'; reason: string };

const ALWAYS_ASK_SIDE_EFFECTS = new Set([
  'administrator',
  'credential-access',
  'delete-data',
  'destructive-git',
  'external-message',
  'external-publish',
  'external-service',
  'opaque-shell',
  'system-install',
]);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function hashValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function canonicalToolKind(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (['bash', 'execute', 'exec', 'shell', 'terminal'].includes(normalized)) return 'command';
  if (['edit', 'patch'].includes(normalized)) return 'write';
  if (['glob', 'grep', 'list', 'search'].includes(normalized)) return 'read';
  if (['fetch', 'web'].includes(normalized)) return 'network';
  if (['mcp', 'task'].includes(normalized)) return 'external';
  return normalized;
}

function normalizedForComparison(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = normalizedForComparison(root);
  const normalizedCandidate = normalizedForComparison(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function assertNoLinkEscape(root: string, candidate: string): void {
  if (!isWithin(root, candidate)) {
    throw new Error(`path escapes workspace: ${candidate}`);
  }
  const rel = relative(root, candidate);
  const segments = rel ? rel.split(/[\\/]+/) : [];
  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error(`symbolic link or junction is not allowed in authority path: ${cursor}`);
    }
    const real = realpathSync.native(cursor);
    if (!isWithin(root, real)) {
      throw new Error(`resolved path escapes workspace: ${cursor}`);
    }
  }
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  const absolute = resolve(workspaceRoot);
  if (!existsSync(absolute)) throw new Error(`workspace does not exist: ${workspaceRoot}`);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`workspace root cannot be a symbolic link or junction: ${workspaceRoot}`);
  }
  return realpathSync.native(absolute);
}

function canonicalWorkspacePath(root: string, requested: string): string {
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  assertNoLinkEscape(root, candidate);
  return candidate;
}

function canonicalHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  let host = trimmed;
  try {
    host = new URL(trimmed).hostname.toLowerCase();
  } catch {
    host = trimmed.replace(/\.$/, '');
  }
  if (!host || !/^[a-z0-9.-]+$/.test(host)) {
    throw new Error(`invalid network host: ${value}`);
  }
  return host;
}

function containsSecretArgument(argv: readonly string[]): boolean {
  const secretFlag = /^(?:--?(?:api[-_]?key|auth(?:orization)?|credential|password|secret|token)|-p)$/i;
  return argv.some((argument, index) => {
    if (
      (secretFlag.test(argument) && index + 1 < argv.length)
      || /^--?(?:api[-_]?key|auth(?:orization)?|credential|password|secret|token)=.+/i.test(argument)
    ) {
      return true;
    }
    try {
      const url = new URL(argument);
      return Boolean(
        url.username
        || url.password
        || Array.from(url.searchParams.keys()).some((key) => (
          /^(?:api[-_]?key|auth(?:orization)?|credential|password|secret|token)$/i.test(key)
        )),
      );
    } catch {
      return false;
    }
  });
}

function normalizeAuthorityRequest(
  root: string,
  request: PlanMeetingTask['authorityRequest'],
): Omit<TaskAuthorityGrant,
  | 'taskId'
  | 'attempt'
  | 'planVersion'
  | 'approvalDecisionId'
  | 'authorityRequestHash'
  | 'workspaceIdentityHash'
  | 'approvedAt'
  | 'expiresAt'
  | 'grantHash'
> {
  const commands = request.commands.map((argv) => {
    if (argv.length === 0 || !argv[0]?.trim()) throw new Error('authority command must include an executable');
    if (containsSecretArgument(argv.slice(1))) {
      throw new Error('secret-bearing command arguments cannot be persisted in an authority grant');
    }
    return argv.map((argument, index) => index === 0 ? argument.trim() : argument);
  });
  return {
    schemaVersion: 1,
    workspaceRoot: root,
    writePaths: uniqueSorted(request.writePaths.map((path) => canonicalWorkspacePath(root, path))),
    allowedToolKinds: uniqueSorted(request.toolKinds.map(canonicalToolKind)),
    allowedWorkingDirectories: uniqueSorted(
      request.workingDirectories.map((path) => canonicalWorkspacePath(root, path)),
    ),
    allowedCommands: commands.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    allowedEnvironmentKeys: uniqueSorted(request.environmentKeys.map((key) => key.trim())),
    maxCommandTimeoutMs: request.maxCommandTimeoutMs,
    allowedNetworkHosts: uniqueSorted(request.networkHosts.map(canonicalHost)),
  };
}

export function hashTaskAuthorityRequest(request: PlanMeetingTask['authorityRequest']): string {
  return hashValue({
    writePaths: uniqueSorted(request.writePaths.map((path) => path.trim().replaceAll('\\', '/'))),
    toolKinds: uniqueSorted(request.toolKinds.map(canonicalToolKind)),
    workingDirectories: uniqueSorted(
      request.workingDirectories.map((path) => path.trim().replaceAll('\\', '/')),
    ),
    commands: request.commands.map((argv) => [...argv])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    environmentKeys: uniqueSorted(request.environmentKeys.map((key) => key.trim())),
    maxCommandTimeoutMs: request.maxCommandTimeoutMs,
    networkHosts: uniqueSorted(request.networkHosts.map(canonicalHost)),
  });
}

function workspaceHash(root: string): string {
  const stat = lstatSync(root);
  return hashValue({
    root: normalizedForComparison(root),
    device: stat.dev,
    inode: stat.ino,
  });
}

function grantHash(grant: Omit<TaskAuthorityGrant, 'grantHash'>): string {
  return hashValue(grant);
}

export function compileTaskAuthority(
  taskId: string,
  attempt: number,
  planVersion: number,
  approvalDecisionId: string,
  workspaceRoot: string,
  request: PlanMeetingTask['authorityRequest'],
  approvedAt: number,
): TaskAuthorityGrant {
  if (!taskId.trim()) throw new Error('taskId is required');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('attempt must be positive');
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) throw new Error('planVersion must be positive');
  if (!approvalDecisionId.trim()) throw new Error('approvalDecisionId is required');
  if (!Number.isSafeInteger(approvedAt) || approvedAt < 0) throw new Error('approvedAt must be nonnegative');
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const normalized = normalizeAuthorityRequest(root, request);
  const withoutHash: Omit<TaskAuthorityGrant, 'grantHash'> = {
    ...normalized,
    taskId: taskId.trim(),
    attempt,
    planVersion,
    approvalDecisionId: approvalDecisionId.trim(),
    authorityRequestHash: hashTaskAuthorityRequest(request),
    workspaceIdentityHash: workspaceHash(root),
    approvedAt,
    expiresAt: approvedAt + DEFAULT_TASK_AUTHORITY_TTL_MS,
  };
  return taskAuthorityGrantSchema.parse({
    ...withoutHash,
    grantHash: grantHash(withoutHash),
  });
}

export function compileReworkTaskAuthority(
  previous: TaskAuthorityGrant,
  attempt: number,
  workspaceRoot: string,
  request: PlanMeetingTask['authorityRequest'],
): TaskAuthorityGrant {
  const previousRequest = {
    writePaths: previous.writePaths,
    toolKinds: previous.allowedToolKinds,
    workingDirectories: previous.allowedWorkingDirectories,
    commands: previous.allowedCommands,
    environmentKeys: previous.allowedEnvironmentKeys,
    maxCommandTimeoutMs: previous.maxCommandTimeoutMs,
    networkHosts: previous.allowedNetworkHosts,
  };
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const next = normalizeAuthorityRequest(root, request);
  const isSubset = (values: readonly string[], allowed: readonly string[]) => (
    values.every((value) => allowed.includes(value))
  );
  const relativePathsCovered = (
    values: readonly string[],
    valueRoot: string,
    allowed: readonly string[],
    allowedRoot: string,
  ) => (
    values.every((value) => {
      const valueRelative = resolve('/', relative(valueRoot, value));
      return allowed.some((allowedPath) => (
        isWithin(
          resolve('/', relative(allowedRoot, allowedPath)),
          valueRelative,
        )
      ));
    })
  );
  const commandsCovered = next.allowedCommands.every((command) => (
    previous.allowedCommands.some((allowed) => (
      allowed.length === command.length
      && allowed.every((argument, index) => argument === command[index])
    ))
  ));
  if (
    !relativePathsCovered(
      next.writePaths,
      root,
      previousRequest.writePaths,
      previous.workspaceRoot,
    )
    || !isSubset(next.allowedToolKinds, previousRequest.toolKinds)
    || !relativePathsCovered(
      next.allowedWorkingDirectories,
      root,
      previousRequest.workingDirectories,
      previous.workspaceRoot,
    )
    || !commandsCovered
    || !isSubset(next.allowedEnvironmentKeys, previousRequest.environmentKeys)
    || next.maxCommandTimeoutMs > previousRequest.maxCommandTimeoutMs
    || !isSubset(next.allowedNetworkHosts, previousRequest.networkHosts)
  ) {
    throw new Error('rework authority cannot widen without a new plan approval');
  }
  return compileTaskAuthority(
    previous.taskId,
    attempt,
    previous.planVersion,
    previous.approvalDecisionId,
    workspaceRoot,
    request,
    previous.approvedAt,
  );
}

function verifyGrantIntegrity(grant: TaskAuthorityGrant): boolean {
  const parsed = taskAuthorityGrantSchema.safeParse(grant);
  if (!parsed.success) return false;
  const { grantHash: storedHash, ...withoutHash } = parsed.data;
  return grantHash(withoutHash) === storedHash;
}

function canonicalRequestPath(root: string, value: string): string | null {
  try {
    return canonicalWorkspacePath(root, value);
  } catch {
    return null;
  }
}

function pathCovered(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(root, candidate));
}

export function evaluateTaskAuthority(
  grant: TaskAuthorityGrant,
  request: CanonicalExecutionRequest,
  now = Date.now(),
): AuthorityDecision {
  if (!verifyGrantIntegrity(grant)) return { kind: 'deny', reason: 'invalid-grant-hash' };
  if (request.taskId !== grant.taskId) return { kind: 'deny', reason: 'task-mismatch' };
  if (request.attempt !== grant.attempt) return { kind: 'deny', reason: 'attempt-mismatch' };
  if (now > grant.expiresAt) return { kind: 'deny', reason: 'grant-expired' };
  try {
    if (workspaceHash(canonicalWorkspaceRoot(grant.workspaceRoot)) !== grant.workspaceIdentityHash) {
      return { kind: 'deny', reason: 'workspace-identity-mismatch' };
    }
  } catch {
    return { kind: 'deny', reason: 'workspace-identity-unavailable' };
  }
  const requestRoot = canonicalRequestPath(grant.workspaceRoot, request.workspaceRoot);
  if (!requestRoot || normalizedForComparison(requestRoot) !== normalizedForComparison(grant.workspaceRoot)) {
    return { kind: 'deny', reason: 'workspace-mismatch' };
  }
  const highRisk = request.sideEffects.find((effect) => ALWAYS_ASK_SIDE_EFFECTS.has(effect));
  if (highRisk || request.kind === 'external') {
    return { kind: 'ask-user', reason: `high-risk:${highRisk ?? 'external-service'}` };
  }
  if (!grant.allowedToolKinds.includes(request.kind)) {
    return { kind: 'deny', reason: 'tool-kind-not-granted' };
  }
  if (request.kind === 'write' && request.writePaths.length === 0) {
    return { kind: 'deny', reason: 'write-target-missing' };
  }
  if (request.kind === 'network' && request.networkHosts.length === 0) {
    return { kind: 'deny', reason: 'network-host-missing' };
  }
  for (const path of request.readPaths) {
    const canonical = canonicalRequestPath(grant.workspaceRoot, path);
    if (!canonical) return { kind: 'deny', reason: 'read-path-escape' };
  }
  for (const path of request.writePaths) {
    const canonical = canonicalRequestPath(grant.workspaceRoot, path);
    if (!canonical || !pathCovered(canonical, grant.writePaths)) {
      return { kind: 'deny', reason: 'write-path-not-granted' };
    }
  }
  if (request.kind === 'command') {
    const cwd = request.cwd
      ? canonicalRequestPath(grant.workspaceRoot, request.cwd)
      : grant.workspaceRoot;
    if (!cwd || !pathCovered(cwd, grant.allowedWorkingDirectories)) {
      return { kind: 'deny', reason: 'cwd-not-granted' };
    }
    const command = [request.executable!, ...(request.argv ?? [])];
    if (!grant.allowedCommands.some((allowed) => (
      allowed.length === command.length
      && allowed.every((argument, index) => argument === command[index])
    ))) {
      return { kind: 'deny', reason: 'command-not-granted' };
    }
    if (request.environmentKeys.some((key) => !grant.allowedEnvironmentKeys.includes(key))) {
      return { kind: 'deny', reason: 'environment-key-not-granted' };
    }
    if (
      request.timeoutMs !== undefined
      && request.timeoutMs > grant.maxCommandTimeoutMs
    ) {
      return { kind: 'deny', reason: 'command-timeout-exceeds-grant' };
    }
  }
  if (request.networkHosts.some((host) => !grant.allowedNetworkHosts.includes(canonicalHost(host)))) {
    return { kind: 'deny', reason: 'network-host-not-granted' };
  }
  return { kind: 'allow', reason: 'within-task-authority' };
}

export function summarizeCanonicalRequest(request: CanonicalExecutionRequest): Record<string, unknown> {
  return {
    schemaVersion: request.schemaVersion,
    taskId: request.taskId,
    attempt: request.attempt,
    backendId: request.backendId,
    kind: request.kind,
    readPaths: [...request.readPaths],
    writePaths: [...request.writePaths],
    networkHosts: [...request.networkHosts],
    environmentKeys: [...request.environmentKeys],
    sideEffects: [...request.sideEffects],
    ...(request.cwd ? { cwd: request.cwd } : {}),
    ...(request.executable ? { executable: request.executable } : {}),
    ...(request.argv ? { argv: [...request.argv] } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    nativeRequestId: request.nativeRequestId,
  };
}
