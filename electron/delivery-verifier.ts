import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { isolatedSubprocessEnv } from './backends/backend-environment.js';
import type {
  VerificationEvidence,
  WorkOrder,
} from './delivery-harness.js';
import type { WorkReport } from './worker-protocol.js';

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface VerificationCheck {
  criterionId: string;
  description: string;
  status: 'passed' | 'failed' | 'manual-pending';
  exitCode?: number | null;
  output?: string;
  error?: string;
}

export class CommandDeliveryVerifier {
  async verify(order: WorkOrder, report: WorkReport): Promise<VerificationEvidence> {
    const pathError = validateReportedPaths(order.workspace, report);
    if (pathError) return { passed: false, checks: [], error: pathError };

    const checks: VerificationCheck[] = [];
    for (const criterion of order.acceptanceCriteria) {
      if (criterion.verification.kind === 'manual') {
        checks.push({
          criterionId: criterion.id,
          description: criterion.description,
          status: 'manual-pending',
        });
        continue;
      }
      const result = await runCriterion(
        criterion.id,
        criterion.description,
        criterion.verification.argv,
        order.workspace,
        criterion.verification.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      checks.push(result);
      if (result.status === 'failed') {
        return {
          passed: false,
          checks,
          error: result.error ?? `verification failed: ${criterion.id}`,
        };
      }
    }
    return { passed: true, checks };
  }
}

function validateReportedPaths(workspace: string, report: WorkReport): string | null {
  const base = resolve(workspace);
  for (const file of report.files) {
    const absolute = resolve(base, file.path);
    if (absolute !== base && !absolute.startsWith(base + sep)) {
      return `reported path escapes workspace: ${file.path}`;
    }
    if (file.action !== 'deleted' && existsSync(absolute)) {
      try {
        const real = realpathSync(absolute);
        const realBase = realpathSync(base);
        if (real !== realBase && !real.startsWith(realBase + sep)) {
          return `reported path resolves outside workspace: ${file.path}`;
        }
      } catch (error) {
        return `cannot inspect reported path ${file.path}: ${String(error)}`;
      }
    }
  }
  return null;
}

function runCriterion(
  criterionId: string,
  description: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<VerificationCheck> {
  return new Promise((resolveCheck) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: isolatedSubprocessEnv(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const append = (chunk: Buffer | string) => {
      if (output.length >= OUTPUT_LIMIT) return;
      output += String(chunk).slice(0, OUTPUT_LIMIT - output.length);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const finish = (check: VerificationCheck) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCheck({ ...check, output: redact(output) });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        criterionId,
        description,
        status: 'failed',
        error: `verification timed out after ${timeoutMs} ms`,
      });
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => finish({
      criterionId,
      description,
      status: 'failed',
      error: error.message,
    }));
    child.once('exit', (code, signal) => finish({
      criterionId,
      description,
      status: code === 0 ? 'passed' : 'failed',
      exitCode: code,
      error: code === 0 ? undefined : `command exited ${code ?? signal ?? 'unknown'}`,
    }));
  });
}

function redact(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}
