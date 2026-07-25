import { execFileSync } from 'node:child_process';
import { getClaudeCodeCliSource } from '../claude-cli/resolve.js';

export type WorkerRuntimeState =
  | 'available'
  | 'needs-install'
  | 'needs-login'
  | 'version-incompatible'
  | 'contract-disabled'
  | 'diagnostic-failed';

const EXPECTED_VERSION: Readonly<Record<string, string>> = {
  'claude-code': '2.1.150',
  codex: '0.144.1',
  kimi: '0.24.1',
  opencode: '1.18.3',
};

export interface WorkerRuntimeAssessment {
  state: WorkerRuntimeState;
  version: string | null;
  expectedVersion: string | null;
  reason: string;
}

export const WORKER_STABILITY_GATES = [
  'runtime-compatible',
  'auth-ready',
  'profile-compilation',
  'work-report',
  'interrupt',
  'resume',
  'permission-bridge',
  'canonical-permission-normalization',
  'recovery',
  'real-vertical-smoke',
] as const;

export type WorkerStabilityGate = (typeof WORKER_STABILITY_GATES)[number];
export type WorkerReleaseTier = 'stable' | 'experimental' | 'blocked';

export interface RealWorkerVerticalEvidence {
  schemaVersion: 1;
  kind: 'real-backend-smoke';
  backendId: string;
  runtimeVersion: string;
  runId: string;
  verifiedAt: string;
  checks: Array<
    | 'work-report'
    | 'interrupt'
    | 'resume'
    | 'permission-bridge'
    | 'canonical-permission-normalization'
    | 'recovery'
  >;
}

export interface WorkerStabilityEvidence {
  runtimeCompatible: boolean;
  authReady: boolean;
  profileCompilation: boolean;
  workReport: boolean;
  interrupt: boolean;
  resume: boolean;
  permissionBridge: boolean;
  canonicalPermissionNormalization: boolean;
  recovery: boolean;
  realVerticalSmoke?: RealWorkerVerticalEvidence;
}

export interface WorkerReleaseAssessment {
  schemaVersion: 1;
  backendId: string;
  tier: WorkerReleaseTier;
  gates: Record<WorkerStabilityGate, boolean>;
  blockers: WorkerStabilityGate[];
  reason: string;
  evidenceRunId?: string;
}

/** Backends cleared as stable Workers in the first managed-collaboration
 *  release. Every other executeTasks backend ships as experimental by policy,
 *  even when its structural gates are green, so the UI must label them. */
export const FIRST_RELEASE_STABLE_WORKERS = new Set(['claude-code', 'codex']);
const REQUIRED_REAL_CHECKS = new Set<RealWorkerVerticalEvidence['checks'][number]>([
  'work-report',
  'interrupt',
  'resume',
  'permission-bridge',
  'canonical-permission-normalization',
  'recovery',
]);

function validRealVerticalEvidence(
  backendId: string,
  expectedRuntimeVersion: string | null,
  evidence: RealWorkerVerticalEvidence | undefined,
): evidence is RealWorkerVerticalEvidence {
  if (
    !evidence
    || evidence.schemaVersion !== 1
    || evidence.kind !== 'real-backend-smoke'
    || evidence.backendId !== backendId
    || !evidence.runId.trim()
    || !Number.isFinite(Date.parse(evidence.verifiedAt))
    || (expectedRuntimeVersion !== null && evidence.runtimeVersion !== expectedRuntimeVersion)
  ) return false;
  const checks = new Set(evidence.checks);
  return checks.size === evidence.checks.length
    && [...REQUIRED_REAL_CHECKS].every((check) => checks.has(check));
}

/** Release qualification is deliberately separate from the broad
 * `executeTasks` implementation capability. Mocked adapter tests may prove
 * individual contract pieces, but only an exact-version real Backend smoke
 * can close the final gate. OpenCode and Kimi remain experimental by first
 * release policy even when their structural gates are green. */
export function assessWorkerRelease(input: {
  backendId: string;
  implementationEnabled: boolean;
  expectedRuntimeVersion: string | null;
  evidence: WorkerStabilityEvidence;
}): WorkerReleaseAssessment {
  const realVerticalSmoke = validRealVerticalEvidence(
    input.backendId,
    input.expectedRuntimeVersion,
    input.evidence.realVerticalSmoke,
  );
  const gates: Record<WorkerStabilityGate, boolean> = {
    'runtime-compatible': input.evidence.runtimeCompatible,
    'auth-ready': input.evidence.authReady,
    'profile-compilation': input.evidence.profileCompilation,
    'work-report': input.evidence.workReport,
    interrupt: input.evidence.interrupt,
    resume: input.evidence.resume,
    'permission-bridge': input.evidence.permissionBridge,
    'canonical-permission-normalization': input.evidence.canonicalPermissionNormalization,
    recovery: input.evidence.recovery,
    'real-vertical-smoke': realVerticalSmoke,
  };
  const blockers = WORKER_STABILITY_GATES.filter((gate) => !gates[gate]);
  if (!input.implementationEnabled) {
    return {
      schemaVersion: 1,
      backendId: input.backendId,
      tier: 'blocked',
      gates,
      blockers,
      reason: 'Worker implementation contract is disabled.',
    };
  }
  if (FIRST_RELEASE_STABLE_WORKERS.has(input.backendId) && blockers.length === 0) {
    return {
      schemaVersion: 1,
      backendId: input.backendId,
      tier: 'stable',
      gates,
      blockers: [],
      reason: 'All structural and real Backend stability gates passed.',
      evidenceRunId: input.evidence.realVerticalSmoke!.runId,
    };
  }
  return {
    schemaVersion: 1,
    backendId: input.backendId,
    tier: 'experimental',
    gates,
    blockers,
    reason: FIRST_RELEASE_STABLE_WORKERS.has(input.backendId)
      ? `Worker remains experimental until ${blockers.join(', ') || 'release policy'} passes.`
      : 'First-release policy keeps this Worker experimental.',
    ...(realVerticalSmoke ? { evidenceRunId: input.evidence.realVerticalSmoke!.runId } : {}),
  };
}

export function extractRuntimeVersion(output: string): string | null {
  return output.match(/(?:^|[^\d])v?(\d+\.\d+\.\d+)(?:[^\d]|$)/)?.[1] ?? null;
}

export function resolveWorkerExpectedVersion(
  backendId: string,
  probedVersion: string | null,
  options?: { claudeCodeCliSource?: 'bundled' | 'system' },
): string | null {
  if (backendId === 'claude-code' && options?.claudeCodeCliSource === 'system') {
    return probedVersion;
  }
  return EXPECTED_VERSION[backendId] ?? null;
}

/** Worker runtime gate that respects persisted Claude CLI source settings. */
export function assessConfiguredWorkerRuntime(input: {
  backendId: string;
  installed: boolean;
  implementationEnabled: boolean;
  authenticated: boolean;
  version: string | null;
  claudeCodeCliSource?: 'bundled' | 'system';
}): WorkerRuntimeAssessment {
  const claudeCodeCliSource = input.claudeCodeCliSource
    ?? (input.backendId === 'claude-code' ? getClaudeCodeCliSource() : undefined);
  const expectedVersionOverride = input.backendId === 'claude-code'
    ? resolveWorkerExpectedVersion(input.backendId, input.version, { claudeCodeCliSource })
    : undefined;
  return assessWorkerRuntime({
    backendId: input.backendId,
    installed: input.installed,
    implementationEnabled: input.implementationEnabled,
    authenticated: input.authenticated,
    version: input.version,
    ...(expectedVersionOverride !== undefined ? { expectedVersionOverride } : {}),
  });
}

export function assessWorkerRuntime(input: {
  backendId: string;
  installed: boolean;
  implementationEnabled: boolean;
  authenticated: boolean;
  version: string | null;
  expectedVersionOverride?: string | null;
}): WorkerRuntimeAssessment {
  const expectedVersion = input.expectedVersionOverride !== undefined
    ? input.expectedVersionOverride
    : (EXPECTED_VERSION[input.backendId] ?? null);
  if (!input.implementationEnabled) {
    return {
      state: 'contract-disabled',
      version: input.version,
      expectedVersion,
      reason: '该 Backend 尚未通过 AhaStation Worker 契约测试。',
    };
  }
  if (!input.installed) {
    return {
      state: 'needs-install',
      version: null,
      expectedVersion,
      reason: '未找到可执行文件，请先安装。',
    };
  }
  if (expectedVersion && input.version !== expectedVersion) {
    return {
      state: input.version ? 'version-incompatible' : 'diagnostic-failed',
      version: input.version,
      expectedVersion,
      reason: input.version
        ? input.backendId === 'claude-code'
          ? `检测到 ${input.version}，当前仅验证 ${expectedVersion}。请在 Lobby → Host CLI → Claude Code CLI 来源 中选择「系统 PATH」以使用本机版本，或选择「内置版本」使用 ${expectedVersion}。`
          : `检测到 ${input.version}，当前仅验证 ${expectedVersion}。`
        : '无法读取运行时版本。',
    };
  }
  if (!input.authenticated) {
    return {
      state: 'needs-login',
      version: input.version,
      expectedVersion,
      reason: '运行时可用，但尚未通过认证检查。',
    };
  }
  return {
    state: 'available',
    version: input.version,
    expectedVersion,
    reason: '安装、版本、认证和 Worker 契约均已就绪。',
  };
}

export function probeWorkerRuntimeVersion(backendId: string, binaryPath: string | null): string | null {
  if (!binaryPath) return null;
  try {
    // JS stubs (used by injected-session tests) are not directly exec-able on
    // Windows; run them through the current Node binary instead.
    const isJsStub = /\.(c|m)?js$/i.test(binaryPath);
    // npm .cmd/.bat shims (e.g. a PATH-installed claude CLI on Windows) can
    // only be launched through a shell; quote the path so spaces survive.
    const isWinShim = process.platform === 'win32' && (
      /\.(cmd|bat)$/i.test(binaryPath)
      || (!/\.(?:exe|cmd|bat|js|mjs|cjs)$/i.test(binaryPath) && !/node_modules[\\/]/i.test(binaryPath))
    );
    const output = execFileSync(
      isJsStub ? process.execPath : isWinShim ? `"${binaryPath}"` : binaryPath,
      isJsStub ? [binaryPath, '--version'] : ['--version'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3_000,
        windowsHide: true,
        ...(isWinShim ? { shell: true } : {}),
      },
    );
    return extractRuntimeVersion(output);
  } catch {
    return null;
  }
}
