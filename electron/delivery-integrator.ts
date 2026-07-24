import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type {
  DeliveryCandidate,
  DeliveryView,
} from './delivery-harness.js';

export interface WorkspaceIntegration {
  [key: string]: unknown;
  kind: 'git-worktree' | 'shared-locked';
  sourceRevision: string;
  resultRevision?: string;
  workspace: string;
}

/**
 * Integrates only a fast-forwarding task worktree. Any conflict, moved base,
 * or commit failure is surfaced while the worktree remains on disk.
 */
export class WorkspaceDeliveryIntegrator {
  constructor(private readonly baseCwd: string) {}

  async integrate(view: DeliveryView, candidate: DeliveryCandidate): Promise<WorkspaceIntegration> {
    if (view.sourceRevision === 'non-git') {
      return {
        kind: 'shared-locked',
        sourceRevision: view.sourceRevision,
        workspace: view.workspace,
      };
    }
    if (!existsSync(view.workspace)) throw new Error(`task workspace is missing: ${view.workspace}`);

    const baseRevision = await git(this.baseCwd, ['rev-parse', 'HEAD']);
    if (baseRevision !== view.sourceRevision) {
      throw new Error(
        `base revision moved from ${view.sourceRevision} to ${baseRevision}; task worktree preserved at ${view.workspace}`,
      );
    }

    const reportedPaths = normalizeReportedPaths(view.workspace, candidate);
    const dirtyPaths = await changedPaths(view.workspace);
    const unreported = dirtyPaths.filter((path) => !reportedPaths.has(path));
    if (unreported.length > 0) {
      throw new Error(
        `worktree contains unreported changes (${unreported.join(', ')}); task worktree preserved at ${view.workspace}`,
      );
    }
    if (dirtyPaths.length > 0) {
      // Scope staging to the reviewed report. Never let a broad `git add -A`
      // pull unrelated Worker side effects into an accepted delivery.
      await git(view.workspace, ['add', '-A', '--', ...reportedPaths]);
      await git(view.workspace, [
        '-c', 'user.name=AhaStation Delivery',
        '-c', 'user.email=delivery@ahastation.local',
        'commit', '-m', `AhaStation delivery ${view.id} attempt ${view.attempt}`,
      ]);
    }
    const resultRevision = await git(view.workspace, ['rev-parse', 'HEAD']);
    if (resultRevision !== view.sourceRevision) {
      await git(this.baseCwd, ['merge', '--ff-only', resultRevision]);
    }

    try {
      await git(this.baseCwd, ['worktree', 'remove', view.workspace]);
    } catch (error) {
      // The integration is already durable in base. Cleanup failure should be
      // visible but must not roll back the accepted commit.
      console.warn('[delivery-integrator] integrated but could not remove worktree', {
        workspace: view.workspace,
        error: String(error),
      });
    }
    return {
      kind: 'git-worktree',
      sourceRevision: view.sourceRevision,
      resultRevision,
      workspace: view.workspace,
    };
  }
}

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return stdout;
}

function normalizeReportedPaths(
  workspace: string,
  candidate: DeliveryCandidate,
): Set<string> {
  const root = resolve(workspace);
  const paths = new Set<string>();
  for (const file of candidate.report.files) {
    const absolute = isAbsolute(file.path) ? resolve(file.path) : resolve(root, file.path);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`reported path escapes task workspace: ${file.path}`);
    }
    const rel = relative(root, absolute).split(sep).join('/');
    if (rel) paths.add(rel);
  }
  return paths;
}

async function changedPaths(workspace: string): Promise<string[]> {
  const tracked = (await gitRaw(
    workspace,
    ['diff', '--name-only', '--no-renames', '-z', 'HEAD'],
  )).split('\0').filter(Boolean);
  const untracked = (await gitRaw(
    workspace,
    ['ls-files', '--others', '--exclude-standard', '-z'],
  )).split('\0').filter(Boolean);
  return Array.from(new Set([...tracked, ...untracked].map((path) => path.split('\\').join('/'))));
}
