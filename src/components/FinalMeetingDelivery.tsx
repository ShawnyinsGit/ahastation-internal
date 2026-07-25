import { useState } from 'react';
import type { FinalMeetingDecision, MeetingDelivery } from '../types';

interface FinalMeetingDeliveryProps {
  delivery: MeetingDelivery;
  decision: FinalMeetingDecision | null;
  onAccept: () => Promise<{ ok: true } | { ok: false; error: string }>;
  onRequestRework: (reason: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function FinalMeetingDelivery({
  delivery,
  decision,
  onAccept,
  onRequestRework,
}: FinalMeetingDeliveryProps) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'accept' | 'rework' | null>(null);
  const [error, setError] = useState('');
  const decided = decision !== null || delivery.publicationState === 'published';

  const accept = async () => {
    setBusy('accept');
    setError('');
    const result = await onAccept();
    if (!result.ok) setError(result.error);
    setBusy(null);
  };
  const rework = async () => {
    const normalized = reason.trim();
    if (!normalized) {
      setError('请说明需要返工的原因。');
      return;
    }
    setBusy('rework');
    setError('');
    const result = await onRequestRework(normalized);
    if (!result.ok) setError(result.error);
    setBusy(null);
  };

  return (
    <section className="final-meeting-delivery" aria-labelledby="final-meeting-delivery-title">
      <header>
        <div>
          <p className="final-meeting-delivery-kicker">最终 Meeting 交付</p>
          <h2 id="final-meeting-delivery-title">
            计划 v{delivery.planVersion} 已全部进入 Meeting 集成分支
          </h2>
        </div>
        <span className={`final-meeting-delivery-state is-${delivery.publicationState}`}>
          {delivery.publicationState === 'published' ? '已发布到主工作区' : '仅在 Meeting 集成分支（未发布）'}
        </span>
      </header>

      <dl className="final-meeting-delivery-facts">
        <div><dt>集成 HEAD</dt><dd><code>{delivery.integrationHead.slice(0, 12)}</code></dd></div>
        <div><dt>任务</dt><dd>{delivery.tasks.length} 个已进 Meeting 分支</dd></div>
        <div><dt>文件</dt><dd>{delivery.changedFiles.length} 个变更</dd></div>
        <div><dt>高风险确认</dt><dd>{delivery.approvals.length} 项</dd></div>
      </dl>

      <div className="final-meeting-delivery-grid">
        <section>
          <h3>任务验证与审查</h3>
          {delivery.tasks.map((task) => (
            <article key={task.taskId} className="final-meeting-task-evidence">
              <strong>{task.title}</strong>
              <small>{task.taskId} · Attempt {task.attempt} · {task.integratedCommit.slice(0, 10)}</small>
              <p>✓ 验证 {task.verification.checks.length} 项 · ✓ Diff 审查完成</p>
              {task.limitations.map((item) => <p key={item} className="is-limitation">限制：{item}</p>)}
            </article>
          ))}
        </section>
        <section>
          <h3>集成文件</h3>
          <ul className="final-meeting-file-list">
            {delivery.changedFiles.map((file) => (
              <li key={`${file.taskId}:${file.path}`}>
                <code>{file.path}</code>
                <span>{file.status} · +{file.additions ?? '?'} / -{file.deletions ?? '?'}</span>
              </li>
            ))}
          </ul>
          {delivery.unresolvedWork.length > 0 && (
            <>
              <h3>未解决工作</h3>
              <ul>{delivery.unresolvedWork.map((item) => <li key={item.taskId}>{item.title}: {item.reason}</li>)}</ul>
            </>
          )}
        </section>
      </div>

      {decision?.kind === 'rework' && (
        <p role="status">已创建计划 v{decision.planVersion} 的版本化返工任务；现有集成提交保持不变。</p>
      )}
      {decision?.kind === 'accept' && <p role="status">最终交付已发布到主工作区。</p>}
      {error && <p className="final-meeting-delivery-error" role="alert">{error}</p>}

      {!decided && (
        <footer>
          <button type="button" disabled={busy !== null} onClick={() => void accept()}>
            {busy === 'accept' ? '正在发布…' : '接受最终交付'}
          </button>
          <label>
            <span>返工原因（必填）</span>
            <textarea
              value={reason}
              maxLength={20_000}
              onChange={(event) => setReason(event.target.value)}
              placeholder="说明哪些结果需要调整；已进 Meeting 分支的提交不会被回滚。"
            />
          </label>
          <button
            type="button"
            className="is-secondary"
            disabled={busy !== null || !reason.trim()}
            onClick={() => void rework()}
          >
            {busy === 'rework' ? '正在创建返工计划…' : '请求返工'}
          </button>
          <small>
            任务「已进 Meeting 分支」不等于发布到你的工作区；点「接受最终交付」才会发布。
            返工会创建新版本任务；已进 Meeting 分支的任务和集成提交保持终态、不会被重写。
          </small>
        </footer>
      )}
    </section>
  );
}
