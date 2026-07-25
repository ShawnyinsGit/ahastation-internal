import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type TaskWorkspaceMode = 'read-only' | 'git-worktree' | 'shared-locked';

export interface WorkspaceBaseline {
  kind: 'git-clean' | 'git-dirty' | 'non-git';
  revision: string;
  changedPaths: string[];
  untrackedPaths: string[];
  truncated: boolean;
}

export interface TaskWorkspace {
  kind: TaskWorkspaceMode;
  cwd: string;
  branch?: string;
  sourceRevision: string;
  lockKeys: string[];
  baseline: WorkspaceBaseline;
  /** Managed workspaces may participate in Coordinator acceptance and atomic
   * Meeting publication. Shared in-place execution is deliberately excluded. */
  managed: boolean;
  diagnostic?: 'dirty-base-visible-read-only' | 'shared-locked-compatibility-only';
}

export interface PrepareTaskWorkspaceInput {
  mode: TaskWorkspaceMode;
  writePaths: string[];
  /** The durably accepted Meeting integration head for dependency-released
   * tasks. Omit only when the current clean base HEAD is the intended source. */
  sourceRevision?: string;
}

export interface TaskWorkspaceManagerOptions {
  /** Test seam and future Meeting-scoped worktree allocator root. */
  worktreeRoot?: string;
}

export interface WorkspaceBlockedDiagnostic {
  code: 'dirty-workspace-write-blocked' | 'git-worktree-requires-repository';
  message: string;
  baseline: WorkspaceBaseline;
  actions: Array<'handle-outside-ahastation' | 'revise-to-shared-locked' | 'cancel-task'>;
}

const MAX_BASELINE_PATHS = 500;
const MAX_BASELINE_PATH_CHARS = 64_000;

export class DirtyWorkspaceWriteBlockedError extends Error {
  readonly code = 'dirty-workspace-write-blocked' as const;

  constructor(readonly baseline: WorkspaceBaseline) {
    super(
      'Git workspace has uncommitted changes. Handle them outside AhaStation, '
      + 'choose shared-locked compatibility mode through a versioned plan revision, or cancel the task.',
    );
    this.name = 'DirtyWorkspaceWriteBlockedError';
  }
}

export class UnsupportedWorkspaceModeError extends Error {
  readonly code = 'unsupported-workspace-mode' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'UnsupportedWorkspaceModeError';
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'task';
}

function boundedPaths(paths: string[]): { paths: string[]; truncated: boolean } {
  const result: string[] = [];
  let length = 0;
  let truncated = false;
  for (const path of paths) {
    if (result.length >= MAX_BASELINE_PATHS || length + path.length > MAX_BASELINE_PATH_CHARS) {
      truncated = true;
      break;
    }
    result.push(path);
    length += path.length;
  }
  return { paths: Array.from(new Set(result)).sort(), truncated };
}

/** Parse `git status --porcelain=v1 -z` without reading file contents. Rename
 * records contain a second NUL-delimited source path, which is intentionally
 * consumed and reported alongside the destination. */
function parsePorcelainStatus(output: string): {
  changedPaths: string[];
  untrackedPaths: string[];
  truncated: boolean;
} {
  const records = output.split('\0');
  const changed: string[] = [];
  const untracked: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status === '??') untracked.push(path);
    else changed.push(path);
    if (status.includes('R') || status.includes('C')) {
      const source = records[index + 1];
      if (source) changed.push(source);
      index += 1;
    }
  }
  const boundedChanged = boundedPaths(changed);
  const boundedUntracked = boundedPaths(untracked);
  return {
    changedPaths: boundedChanged.paths,
    untrackedPaths: boundedUntracked.paths,
    truncated: boundedChanged.truncated || boundedUntracked.truncated,
  };
}

/** Return an error message when any write path resolves outside `baseCwd`.
 * Used by plan install and Scheduler readiness so escaping paths never throw
 * through the shared spawn loop. */
export function validateWorkspaceWritePaths(
  baseCwd: string,
  writePaths: readonly string[],
): string | null {
  const base = resolve(baseCwd);
  for (const path of writePaths) {
    const absolute = resolve(baseCwd, path);
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      return `write path escapes workspace: ${path}`;
    }
  }
  return null;
}

/** Meeting-scoped workspace isolation. Clean Git repositories get one real
 * worktree per managed write task. Read-only tasks inspect the selected base
 * directly. Explicit shared mode writes in place under advisory path locks and
 * is always marked as unmanaged compatibility execution. */
export class TaskWorkspaceManager {
  private locks = new Map<string, string>();
  private workspaces = new Map<string, TaskWorkspace>();

  constructor(
    private readonly meetingId: string,
    private readonly baseCwd: string,
    private readonly options: TaskWorkspaceManagerOptions = {},
  ) {}

  /** Same check as {@link validateWorkspaceWritePaths}, scoped to this meeting. */
  validateWritePaths(writePaths: readonly string[]): string | null {
    return validateWorkspaceWritePaths(this.baseCwd, writePaths);
  }

  inspectBaseline(): WorkspaceBaseline {
    if (!this.isGitRepository()) {
      return {
        kind: 'non-git',
        revision: 'non-git',
        changedPaths: [],
        untrackedPaths: [],
        truncated: false,
      };
    }
    const revision = this.resolveCommit('HEAD');
    const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd: this.baseCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 1_048_576,
    });
    const parsed = parsePorcelainStatus(status);
    return {
      kind: parsed.changedPaths.length > 0 || parsed.untrackedPaths.length > 0 || parsed.truncated
        ? 'git-dirty'
        : 'git-clean',
      revision,
      ...parsed,
    };
  }

  /** Return whether a pending task can acquire its workspace without mutating
   * Git, lock, or filesystem state. Dirty isolated writers return false; the
   * subsequent explicit prepare call produces the typed user-facing error.
   * Escaping write paths return false instead of throwing so readiness checks
   * cannot poison the Scheduler spawn loop. */
  canPrepare(taskId: string, input: PrepareTaskWorkspaceInput): boolean {
    if (this.workspaces.has(taskId) || input.mode === 'read-only') return true;
    const baseline = this.inspectBaseline();
    if (input.mode === 'git-worktree') {
      return baseline.kind === 'git-clean';
    }
    try {
      const keys = this.lockKeys(input.writePaths);
      return keys.every((key) => !this.conflictingOwner(key, taskId));
    } catch {
      return false;
    }
  }

  preparationBlock(input: PrepareTaskWorkspaceInput): WorkspaceBlockedDiagnostic | null {
    if (input.mode !== 'git-worktree') return null;
    const baseline = this.inspectBaseline();
    if (baseline.kind === 'git-dirty') {
      const error = new DirtyWorkspaceWriteBlockedError(baseline);
      return {
        code: error.code,
        message: error.message,
        baseline,
        actions: ['handle-outside-ahastation', 'revise-to-shared-locked', 'cancel-task'],
      };
    }
    if (baseline.kind === 'non-git') {
      return {
        code: 'git-worktree-requires-repository',
        message:
          'git-worktree mode requires a Git repository. Revise the task to shared-locked '
          + 'compatibility mode, or initialize a repository outside AhaStation.',
        baseline,
        actions: ['revise-to-shared-locked', 'cancel-task'],
      };
    }
    return null;
  }

  prepare(taskId: string, input: PrepareTaskWorkspaceInput): TaskWorkspace {
    const existing = this.workspaces.get(taskId);
    if (existing) return existing;
    const baseline = this.inspectBaseline();

    if (input.mode === 'read-only') {
      if (input.writePaths.length > 0) {
        throw new UnsupportedWorkspaceModeError('read-only workspace cannot declare write paths');
      }
      const workspace: TaskWorkspace = {
        kind: 'read-only',
        cwd: this.baseCwd,
        sourceRevision: baseline.revision,
        lockKeys: [],
        baseline,
        managed: true,
        ...(baseline.kind === 'git-dirty'
          ? { diagnostic: 'dirty-base-visible-read-only' as const }
          : {}),
      };
      this.workspaces.set(taskId, workspace);
      return workspace;
    }

    if (input.mode === 'git-worktree') {
      if (baseline.kind === 'git-dirty') {
        throw new DirtyWorkspaceWriteBlockedError(baseline);
      }
      if (baseline.kind !== 'git-clean') {
        throw new UnsupportedWorkspaceModeError(
          'git-worktree mode requires a Git repository; choose shared-locked compatibility mode explicitly',
        );
      }
      const sourceRevision = this.resolveCommit(input.sourceRevision ?? baseline.revision);
      const root = this.options.worktreeRoot
        ?? join(app.getPath('userData'), 'worktrees', safeSegment(this.meetingId));
      const cwd = join(root, safeSegment(taskId));
      const branch = `ahastation/${safeSegment(this.meetingId).slice(0, 12)}/${safeSegment(taskId)}`;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!existsSync(cwd)) {
        execFileSync('git', ['worktree', 'add', '-b', branch, cwd, sourceRevision], {
          cwd: this.baseCwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        });
      }
      const workspace: TaskWorkspace = {
        kind: 'git-worktree',
        cwd,
        branch,
        sourceRevision,
        lockKeys: [],
        baseline,
        managed: true,
      };
      this.workspaces.set(taskId, workspace);
      return workspace;
    }

    const keys = this.lockKeys(input.writePaths);
    for (const key of keys) {
      const owner = this.conflictingOwner(key, taskId);
      if (owner && owner !== taskId) {
        throw new Error(`workspace path is locked by ${owner}: ${key}`);
      }
    }
    for (const key of keys) this.locks.set(key, taskId);
    const workspace: TaskWorkspace = {
      kind: 'shared-locked',
      cwd: this.baseCwd,
      sourceRevision: baseline.revision,
      lockKeys: keys,
      baseline,
      managed: false,
      diagnostic: 'shared-locked-compatibility-only',
    };
    this.workspaces.set(taskId, workspace);
    return workspace;
  }

  release(taskId: string, removeWorktree: boolean): void {
    const workspace = this.workspaces.get(taskId);
    if (!workspace) return;
    for (const key of workspace.lockKeys) {
      if (this.locks.get(key) === taskId) this.locks.delete(key);
    }
    if (removeWorktree && workspace.kind === 'git-worktree') {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', workspace.cwd], {
          cwd: this.baseCwd,
          stdio: 'ignore',
          timeout: 30_000,
        });
      } catch {
        try {
          rmSync(workspace.cwd, { recursive: true, force: true });
        } catch {
          // Keep failed cleanup recoverable for manual inspection.
        }
      }
    }
    this.workspaces.delete(taskId);
  }

  private isGitRepository(): boolean {
    try {
      return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: this.baseCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim() === 'true';
    } catch {
      return false;
    }
  }

  private resolveCommit(revision: string): string {
    if (revision !== 'HEAD' && !/^[0-9a-f]{40,64}$/i.test(revision)) {
      throw new UnsupportedWorkspaceModeError(
        `source revision is not an immutable commit id: ${revision}`,
      );
    }
    try {
      return execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
        cwd: this.baseCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      }).trim();
    } catch (error) {
      throw new UnsupportedWorkspaceModeError(
        `source revision is not a valid commit: ${revision}`,
        { cause: error },
      );
    }
  }

  private normalizedLockKey(path: string): string {
    const error = validateWorkspaceWritePaths(this.baseCwd, [path]);
    if (error) throw new Error(error);
    const absolute = resolve(this.baseCwd, path);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  }

  private lockKeys(writePaths: string[]): string[] {
    return writePaths.length > 0
      ? Array.from(new Set(writePaths.map((path) => this.normalizedLockKey(path))))
      : [this.normalizedLockKey('.')];
  }

  private conflictingOwner(key: string, taskId: string): string | undefined {
    for (const [lockedKey, owner] of this.locks) {
      if (owner === taskId) continue;
      if (
        key === lockedKey
        || key.startsWith(lockedKey + sep)
        || lockedKey.startsWith(key + sep)
      ) {
        return owner;
      }
    }
    return undefined;
  }
}
