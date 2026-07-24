import { execFileSync } from 'node:child_process';

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
export function extractRuntimeVersion(output: string): string | null {
  return output.match(/(?:^|[^\d])v?(\d+\.\d+\.\d+)(?:[^\d]|$)/)?.[1] ?? null;
}

export function assessWorkerRuntime(input: {
  backendId: string;
  installed: boolean;
  implementationEnabled: boolean;
  authenticated: boolean;
  version: string | null;
}): WorkerRuntimeAssessment {
  const expectedVersion = EXPECTED_VERSION[input.backendId] ?? null;
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
        ? `检测到 ${input.version}，当前仅验证 ${expectedVersion}。`
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
    const output = execFileSync(binaryPath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_000,
      windowsHide: true,
    });
    return extractRuntimeVersion(output);
  } catch {
    return null;
  }
}
