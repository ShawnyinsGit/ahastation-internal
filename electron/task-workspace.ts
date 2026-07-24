import { app } from 'electron';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export interface TaskWorkspace {
  kind: 'git-worktree' | 'shared-locked';
  cwd: string;
  branch?: string;
  sourceRevision: string;
  lockKeys: string[];
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || 'task';
}

/** Meeting-scoped workspace isolation. Git repositories get one real worktree
 * per task; non-Git directories use declared path locks (or a whole-workspace
 * lock when the task cannot predict its outputs). */
export class TaskWorkspaceManager {
  private locks = new Map<string, string>();
  private workspaces = new Map<string, TaskWorkspace>();

  constructor(
    private readonly meetingId: string,
    private readonly baseCwd: string,
  ) {}

  /** Return whether a pending task can acquire its workspace without
   * mutating lock state. The scheduler uses this to leave contending tasks
   * pending until the current owner finishes instead of treating normal
   * lock contention as a worker launch failure. */
  canPrepare(taskId: string, writePaths: string[] = []): boolean {
    if (this.workspaces.has(taskId) || this.isGitRepository()) return true;
    const keys = this.lockKeys(writePaths);
    return keys.every((key) => !this.conflictingOwner(key, taskId));
  }

  prepare(taskId: string, writePaths: string[] = []): TaskWorkspace {
    const existing = this.workspaces.get(taskId);
    if (existing) return existing;
    if (this.isGitRepository()) {
      const root = join(app.getPath('userData'), 'worktrees', safeSegment(this.meetingId));
      const cwd = join(root, safeSegment(taskId));
      const branch = `ahastation/${safeSegment(this.meetingId).slice(0, 12)}/${safeSegment(taskId)}`;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (!existsSync(cwd)) {
        execFileSync('git', ['worktree', 'add', '-b', branch, cwd, 'HEAD'], {
          cwd: this.baseCwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        });
      }
      const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.baseCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      }).trim();
      const workspace: TaskWorkspace = {
        kind: 'git-worktree',
        cwd,
        branch,
        sourceRevision,
        lockKeys: [],
      };
      this.workspaces.set(taskId, workspace);
      return workspace;
    }

    const keys = this.lockKeys(writePaths);
    for (const key of keys) {
      const owner = this.conflictingOwner(key, taskId);
      if (owner && owner !== taskId) throw new Error(`workspace path is locked by ${owner}: ${key}`);
    }
    for (const key of keys) this.locks.set(key, taskId);
    const workspace: TaskWorkspace = {
      kind: 'shared-locked',
      cwd: this.baseCwd,
      sourceRevision: this.currentRevision(),
      lockKeys: keys,
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
        try { rmSync(workspace.cwd, { recursive: true, force: true }); } catch { /* keep for manual cleanup */ }
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
    } catch { return false; }
  }

  private currentRevision(): string {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: this.baseCwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
    } catch {
      return 'non-git';
    }
  }

  private normalizedLockKey(path: string): string {
    const absolute = resolve(this.baseCwd, path);
    const base = resolve(this.baseCwd);
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      throw new Error(`write path escapes workspace: ${path}`);
    }
    return absolute;
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
      ) return owner;
    }
    return undefined;
  }
}
