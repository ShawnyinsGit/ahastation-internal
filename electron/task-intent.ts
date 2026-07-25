// Lightweight heuristics so vague Talker dispatches still get a safe authority
// envelope. Prefer sandbox write paths and cwd-detected test commands over
// guessing business directories like src/.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Command families we can map onto a concrete argv from workspace markers. */
export type CommandKind = 'test' | 'build' | 'lint';

export interface TaskIntent {
  wantsWrite: boolean;
  wantsCommand: boolean;
  wantsNetwork: boolean;
  commandKinds: CommandKind[];
}

const WRITE_RE = /(?:\b(?:write|edit|create|add|update|fix|refactor|implement|modify|patch|generate|scaffold)\b|写|改|创建|新增|修复|重构|实现|生成)/i;
const TEST_RE = /(?:\b(?:tests?|testing|pytest|jest|vitest|mocha|unittest)\b|跑测试|测试|单测|用例)/i;
const BUILD_RE = /(?:\b(?:build|compile|bundle)\b|构建|编译|打包)/i;
const LINT_RE = /(?:\b(?:lint|eslint|ruff|clippy|typecheck|type-check|tsc)\b|静态检查|类型检查|代码检查)/i;
const NETWORK_RE = /(?:\b(?:fetch|download|https?|curl|wget|api\s*call|web\s*search)\b|下载|抓取|联网)/i;

export function inferTaskIntent(text: string): TaskIntent {
  const blob = text.trim();
  if (!blob) {
    return { wantsWrite: false, wantsCommand: false, wantsNetwork: false, commandKinds: [] };
  }
  const commandKinds: CommandKind[] = [];
  if (TEST_RE.test(blob)) commandKinds.push('test');
  if (BUILD_RE.test(blob)) commandKinds.push('build');
  if (LINT_RE.test(blob)) commandKinds.push('lint');
  return {
    wantsWrite: WRITE_RE.test(blob),
    wantsCommand: commandKinds.length > 0,
    wantsNetwork: NETWORK_RE.test(blob),
    commandKinds,
  };
}

/** Safe in-workspace sandbox for inferred writers. Never invents business paths. */
export function sandboxWritePath(taskId: string): string {
  const safe = taskId.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return `.vibe-assets/tasks/${safe}`;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

const SCRIPT_CANDIDATES: Record<CommandKind, string[]> = {
  test: ['test'],
  build: ['build'],
  lint: ['lint', 'typecheck'],
};

function readPackageJson(root: string): { scripts?: Record<string, unknown> } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return undefined;
  }
}

function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function scriptArgv(manager: PackageManager, script: string): string[] {
  switch (manager) {
    case 'pnpm':
      return ['pnpm', 'run', script];
    case 'yarn':
      return ['yarn', script];
    case 'bun':
      return ['bun', 'run', script];
    default:
      return script === 'test' ? ['npm', 'test'] : ['npm', 'run', script];
  }
}

function nodeCommands(root: string, kinds: CommandKind[]): string[][] | undefined {
  const pkg = readPackageJson(root);
  if (!pkg) return undefined;
  const manager = detectPackageManager(root);
  const scripts = typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : undefined;
  if (!scripts) {
    // No script table to read (workspace root, config-driven setups). Only the
    // test default is safe enough to guess.
    return kinds.includes('test') ? [scriptArgv(manager, 'test')] : [];
  }
  const argvs: string[][] = [];
  for (const kind of kinds) {
    const script = SCRIPT_CANDIDATES[kind].find((name) => typeof scripts[name] === 'string');
    if (script) argvs.push(scriptArgv(manager, script));
  }
  return argvs;
}

function pythonCommands(root: string, kinds: CommandKind[]): string[][] | undefined {
  const marked = existsSync(join(root, 'pyproject.toml'))
    || existsSync(join(root, 'pytest.ini'))
    || existsSync(join(root, 'setup.cfg'));
  if (!marked) return undefined;
  return kinds.includes('test') ? [['pytest']] : [];
}

function goCommands(root: string, kinds: CommandKind[]): string[][] | undefined {
  if (!existsSync(join(root, 'go.mod'))) return undefined;
  const argvs: string[][] = [];
  if (kinds.includes('test')) argvs.push(['go', 'test', './...']);
  if (kinds.includes('build')) argvs.push(['go', 'build', './...']);
  if (kinds.includes('lint')) argvs.push(['go', 'vet', './...']);
  return argvs;
}

function rustCommands(root: string, kinds: CommandKind[]): string[][] | undefined {
  if (!existsSync(join(root, 'Cargo.toml'))) return undefined;
  const argvs: string[][] = [];
  if (kinds.includes('test')) argvs.push(['cargo', 'test']);
  if (kinds.includes('build')) argvs.push(['cargo', 'build']);
  if (kinds.includes('lint')) argvs.push(['cargo', 'clippy']);
  return argvs;
}

const MAKE_TARGETS: Record<CommandKind, string[]> = {
  test: ['test', 'check'],
  build: ['build', 'all'],
  lint: ['lint', 'vet'],
};

function makeCommands(root: string, kinds: CommandKind[]): string[][] | undefined {
  const file = ['Makefile', 'makefile', 'GNUmakefile']
    .map((name) => join(root, name))
    .find((path) => existsSync(path));
  if (!file) return undefined;
  let targets: Set<string>;
  try {
    const body = readFileSync(file, 'utf8').slice(0, 200_000);
    targets = new Set(
      body
        .split(/\r?\n/)
        .map((line) => /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name)),
    );
  } catch {
    return undefined;
  }
  const argvs: string[][] = [];
  for (const kind of kinds) {
    const target = MAKE_TARGETS[kind].find((name) => targets.has(name));
    if (target) argvs.push(['make', target]);
  }
  return argvs;
}

/** Map asked-for command kinds onto concrete argv using workspace markers:
 *  package.json scripts (with the lockfile's package manager), pytest markers,
 *  go.mod, Cargo.toml, Makefile targets. Detectors are tried in order and the
 *  first one that answers the asked kinds wins, so a JS repo whose test lives
 *  in a Makefile still resolves.
 *
 *  Only the workspace root is probed: grants pin the working directory to the
 *  workspace, so a command borrowed from a parent monorepo directory would be
 *  denied as cwd-not-granted (or simply fail) when the Worker runs it here. */
export function detectSuggestedCommands(
  cwd: string | undefined,
  kinds: CommandKind[] = ['test'],
): string[][] {
  if (!cwd?.trim() || kinds.length === 0) return [];
  const root = cwd.trim();
  let detected: string[][] = [];
  for (const detector of [nodeCommands, pythonCommands, goCommands, rustCommands, makeCommands]) {
    const found = detector(root, kinds);
    if (found?.length) {
      detected = found;
      break;
    }
  }
  const seen = new Set<string>();
  return detected.filter((argv) => {
    const key = argv.join('\u0000');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface TaskDispatchDefaults {
  writePaths?: string[];
  workspaceMode?: 'read-only' | 'git-worktree' | 'shared-locked';
  commands?: string[][];
  diagnostic?: 'intent-defaults-applied';
  /** What the runtime filled in, phrased for the Talker and the Tasks panel so
   *  a user can see which authority they never asked for. */
  notes?: string[];
  /** Network intent with no host allowlist: the task cannot fetch anything, so
   *  the Worker must ask for hosts once instead of silently failing. */
  networkHint?: boolean;
}

/** Fill missing authority fields from prompt intent + cwd probes. Explicit
 *  caller values always win; never widens an explicit read-only mode. */
export function applyTaskDispatchDefaults(input: {
  id: string;
  title?: string;
  prompt: string;
  writePaths?: string[];
  workspaceMode?: 'read-only' | 'git-worktree' | 'shared-locked';
  commands?: string[][];
  networkHosts?: string[];
  cwd?: string;
  baselineKind?: 'git-clean' | 'git-dirty' | 'non-git';
}): TaskDispatchDefaults {
  const intent = inferTaskIntent(`${input.title ?? ''} ${input.prompt}`);
  const explicitReadOnly = input.workspaceMode === 'read-only';
  let writePaths = input.writePaths?.length ? [...input.writePaths] : [];
  let workspaceMode = input.workspaceMode;
  let commands = input.commands?.length
    ? input.commands.map((argv) => [...argv])
    : [];
  const notes: string[] = [];
  let applied = false;

  if (
    writePaths.length === 0
    && intent.wantsWrite
    && !explicitReadOnly
  ) {
    writePaths = [sandboxWritePath(input.id)];
    applied = true;
    notes.push(`write sandbox ${writePaths[0]}`);
  }

  if (intent.wantsCommand && commands.length === 0 && !explicitReadOnly) {
    const suggested = detectSuggestedCommands(input.cwd, intent.commandKinds);
    if (suggested.length > 0) {
      commands = suggested;
      applied = true;
      notes.push(`commands ${suggested.map((argv) => argv.join(' ')).join(', ')}`);
      // read-only tasks cannot grant commands; give a sandbox for incidental
      // outputs (coverage, logs) when the ask is test/build-only.
      if (writePaths.length === 0) {
        writePaths = [sandboxWritePath(input.id)];
        notes.push(`write sandbox ${writePaths[0]}`);
      }
    }
  }

  const networkHint = intent.wantsNetwork && (input.networkHosts ?? []).length === 0;
  if (networkHint) {
    notes.push('network hosts not granted — the Worker must request them once');
  }

  if (!workspaceMode) {
    if (writePaths.length > 0 || ((intent.wantsWrite || commands.length > 0) && !explicitReadOnly)) {
      workspaceMode = input.baselineKind && input.baselineKind !== 'git-clean'
        ? 'shared-locked'
        : 'git-worktree';
      // Inferring mode from already-declared writePaths is normal legacy
      // normalization, not an intent default — only mark applied when we
      // invented paths/commands above.
      if (applied) notes.push(`workspace ${workspaceMode}`);
    } else {
      workspaceMode = 'read-only';
    }
  }

  return {
    ...(writePaths.length > 0 ? { writePaths } : {}),
    ...(workspaceMode ? { workspaceMode } : {}),
    ...(commands.length > 0 ? { commands } : {}),
    ...(applied ? { diagnostic: 'intent-defaults-applied' as const } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(networkHint ? { networkHint: true } : {}),
  };
}
