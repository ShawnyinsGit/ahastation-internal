import { useState } from 'react';
import type { WorkerState } from '../lib/meeting-store';

/** 终端模式 worker 的回合结束确认条。adapter 在 Stop hook 触发时发一条带
 *  marker 前缀的 progress 信号（lastText）；任务保持 running，由用户在这里
 *  「标记完成 / 继续指挥 / 标记失败」。完成时 host 合成最小 WorkReport 走
 *  现有 delivery 流水线。 */
export const TERMINAL_TURN_ENDED_MARKER = '[terminal-turn-ended]';

export function TerminalTurnConfirmBar({
  sessionId,
  worker,
}: {
  sessionId: string;
  worker: WorkerState;
}) {
  const [summary, setSummary] = useState('');
  const [submitting, setSubmitting] = useState<'done' | 'failed' | ''>('');
  const [error, setError] = useState('');
  // 「继续指挥」只收起当前这一条；下一次 Stop 信号（eventSeq 前进）重新亮出。
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);

  const turnEnded = worker.status === 'running'
    && (worker.lastText ?? '').startsWith(TERMINAL_TURN_ENDED_MARKER);
  if (!turnEnded || dismissedSeq === (worker.eventSeq ?? 0)) return null;

  const confirm = async (outcome: 'done' | 'failed') => {
    const text = summary.trim() || (outcome === 'done' ? '用户在终端中确认任务完成。' : '用户在终端中标记任务失败。');
    setError('');
    setSubmitting(outcome);
    try {
      const result = await window.vibeMeet.workerPty.confirmTask(sessionId, worker.id, outcome, text);
      if (!result.ok) setError(result.error ?? '提交失败');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting('');
    }
  };

  return (
    <div className="terminal-turn-confirm" role="status">
      <div className="terminal-turn-confirm-title">
        <strong>本轮已结束</strong>
        <small>Claude 在终端中完成了一轮对话，请确认任务去向。</small>
      </div>
      <input
        type="text"
        value={summary}
        placeholder="交付摘要（可选，标记完成时随 WorkReport 提交）"
        onChange={(event) => setSummary(event.target.value)}
        disabled={Boolean(submitting)}
      />
      <div className="terminal-turn-confirm-actions">
        <button
          type="button"
          disabled={Boolean(submitting)}
          onClick={() => void confirm('done')}
        >
          {submitting === 'done' ? '提交中…' : '标记完成'}
        </button>
        <button
          type="button"
          disabled={Boolean(submitting)}
          onClick={() => setDismissedSeq(worker.eventSeq ?? 0)}
        >
          继续指挥
        </button>
        <button
          type="button"
          className="is-danger"
          disabled={Boolean(submitting)}
          onClick={() => void confirm('failed')}
        >
          {submitting === 'failed' ? '提交中…' : '标记失败'}
        </button>
      </div>
      {error && <div className="terminal-turn-confirm-error" role="alert">{error}</div>}
    </div>
  );
}
