import type {
  ReviewVerdict,
  VerificationEvidence,
  WorkOrder,
} from './delivery-harness.js';
import type { WorkReport } from './worker-protocol.js';

export interface ReviewFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export class DeterministicDeliveryReviewer {
  async review(
    _order: WorkOrder,
    report: WorkReport,
    verification: VerificationEvidence,
  ): Promise<ReviewVerdict> {
    const findings: ReviewFinding[] = [];
    const reportOnly = report.files.length === 0;
    if (report.status !== 'completed') {
      findings.push({
        severity: 'error',
        code: 'incomplete-outcome',
        message: `Worker outcome is ${report.status}.`,
      });
    }
    if (!verification.passed) {
      findings.push({
        severity: 'error',
        code: 'verification-failed',
        message: verification.error ?? 'Verification did not pass.',
      });
    }
    for (const test of report.tests) {
      if (test.status === 'failed') {
        findings.push({
          severity: 'error',
          code: 'reported-test-failed',
          message: `${test.command}: ${test.summary ?? 'failed'}`,
        });
      } else if (test.status === 'not-run') {
        // Explore / report-only deliveries honestly skip tests — warn the host
        // instead of auto-failing into a rework loop.
        findings.push({
          severity: reportOnly ? 'warning' : 'error',
          code: 'reported-test-not-run',
          message: `${test.command}: ${test.summary ?? 'not run'}`,
        });
      }
    }
    for (const item of report.unresolved) {
      findings.push({
        severity: item.blocking ? 'error' : 'warning',
        code: item.code,
        message: item.message,
      });
    }
    return {
      passed: !findings.some((finding) => finding.severity === 'error'),
      findings,
    };
  }
}
