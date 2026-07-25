import { CheckCircle2, CircleDashed, FileCode2, GitCommitHorizontal, ShieldCheck } from 'lucide-react';
import type { RendererTaskSnapshot, WorkReport } from '../types';

type ReviewMode = 'diff' | 'verification' | 'integration';

function latestAttempt(snapshot: RendererTaskSnapshot) {
  return [...snapshot.attempts].sort((left, right) => right.attempt - left.attempt)[0];
}

function asWorkReport(value: unknown): WorkReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Partial<WorkReport>;
  return Array.isArray(report.files) && Array.isArray(report.tests)
    ? report as WorkReport
    : null;
}

function evidenceObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function TaskReviewPanel({
  snapshot,
  mode,
}: {
  snapshot: RendererTaskSnapshot;
  mode: ReviewMode;
}) {
  const attempt = latestAttempt(snapshot);
  const report = asWorkReport(attempt?.report);
  const verification = evidenceObject(attempt?.verification);
  const coverage = evidenceObject(attempt?.reviewCoverage);
  const reviewedChunks = typeof coverage.reviewedChunks === 'number' ? coverage.reviewedChunks : 0;
  const totalChunks = typeof coverage.totalChunks === 'number' ? coverage.totalChunks : 0;
  const coveragePercent = totalChunks > 0
    ? Math.min(100, Math.round((reviewedChunks / totalChunks) * 100))
    : 0;

  if (mode === 'diff') {
    return (
      <div className="task-review-panel">
        <section className="task-review-coverage">
          <header>
            <span>Diff review coverage</span>
            <strong>{reviewedChunks} / {totalChunks || '—'}</strong>
          </header>
          <div className="task-review-progress" aria-label={`Diff review ${coveragePercent}%`}>
            <span style={{ width: `${coveragePercent}%` }} />
          </div>
          <small>
            {attempt?.candidateCommit
              ? `Frozen candidate ${attempt.candidateCommit.slice(0, 12)}`
              : '候选提交尚未冻结；Coordinator 不会接受漂移中的 Diff。'}
          </small>
        </section>

        <section className="task-file-evidence">
          <header><FileCode2 size={15} /> 文件与分片</header>
          {report?.files.length ? (
            <ul>
              {report.files.map((file) => (
                <li key={`${file.action}:${file.path}`}>
                  <span className={`is-${file.action}`}>{file.action}</span>
                  <code>{file.path}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className="task-empty-state">Worker 尚未提交可冻结的文件清单。</p>
          )}
        </section>
      </div>
    );
  }

  if (mode === 'verification') {
    return (
      <div className="task-review-panel">
        <section className="task-verification-summary">
          <header><ShieldCheck size={16} /> Verification</header>
          <strong>{String(verification.status ?? '等待验证')}</strong>
          {report?.tests.length ? (
            <ul>
              {report.tests.map((test, index) => (
                <li key={`${test.command}:${index}`}>
                  {test.status === 'passed'
                    ? <CheckCircle2 size={14} />
                    : <CircleDashed size={14} />}
                  <div>
                    <code>{test.command}</code>
                    <small>{test.summary ?? test.status}</small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="task-empty-state">尚无独立验证证据。</p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="task-review-panel">
      <section className="task-integration-status">
        <header><GitCommitHorizontal size={16} /> Integration Queue</header>
        <div className="task-integration-stage">
          <span className={`task-status-mark is-${snapshot.task.status}`} />
          <div>
            <strong>{snapshot.task.status}</strong>
            <small>
              {snapshot.task.status === 'accepted'
                ? '已通过串行 Integration Queue 写入主线。'
                : attempt?.candidateCommit
                  ? 'Coordinator 验收完成后将自动进入精确 cherry-pick 队列。'
                  : '等待冻结候选提交与完整审查。'}
            </small>
          </div>
        </div>
        {attempt?.candidateCommit && (
          <code className="task-candidate-commit">{attempt.candidateCommit}</code>
        )}
        <p className="task-integration-note">
          正常模式没有逐任务用户验收按钮；Coordinator 自动审查、接受并串行集成，
          用户只在最终 Meeting 验收整体结果。
        </p>
      </section>
    </div>
  );
}
