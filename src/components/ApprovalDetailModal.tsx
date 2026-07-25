import { useEffect, useState } from 'react';
import type { RiskAssessment } from '../lib/risk-classify';

interface ApprovalDetailModalProps {
  open: boolean;
  /** 四要素：项目 / 任务 / 客户端 / 动作（BR-A2）。 */
  project: string;
  task: string;
  client: string;
  assessment: RiskAssessment;
  /** 完整参数（JSON 展示）。 */
  rawInput: Record<string, unknown>;
  blocked?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * P5 高风险详情页（03 §3.3 / 04 P5）：影响面清单 + 「我已阅读」复选框 +
 * 勾选前禁用确认按钮 + 危险色确认键；Esc/取消不做任何隐式确认。
 * Linux（Debian 11）无 macOS 原生确认框体系，用应用内置顶模态替代（平台差距已记录）。
 */
export function ApprovalDetailModal({
  open,
  project,
  task,
  client,
  assessment,
  rawInput,
  blocked = false,
  busy = false,
  error,
  onConfirm,
  onCancel,
}: ApprovalDetailModalProps) {
  const [read, setRead] = useState(false);

  useEffect(() => {
    if (open) setRead(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="aha-modal-backdrop" onClick={onCancel}>
      <div
        className="aha-modal"
        role="dialog"
        aria-modal="true"
        aria-label="高风险操作确认"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aha-modal-head">
          <h3 className="aha-modal-title">
            {blocked ? '需完整确认 · 禁止快捷批准' : '高风险操作 · 需完整确认'}
          </h3>
          <span className="aha-risk-badge aha-risk-badge-high">风险：{blocked ? '禁止快捷' : '高'}</span>
        </div>
        <p className="aha-modal-sub">
          请逐项核对以下四要素与影响面。确认对象仅限当前请求，不会扩大任务授权。
        </p>

        <div className="aha-detail-box">
          <div className="aha-kv"><strong>项目</strong><span>{project}</span></div>
          <div className="aha-kv"><strong>任务</strong><span>{task}</span></div>
          <div className="aha-kv"><strong>客户端</strong><span>{client}</span></div>
          <div className="aha-kv">
            <strong>动作</strong>
            <span>
              {assessment.action}
              {assessment.target && <code className="aha-mono"> {assessment.target}</code>}
            </span>
          </div>
        </div>

        <div className="aha-impact-list">
          <div className="aha-impact-title">影响面</div>
          <ul>
            {assessment.impactList.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
            <li>{assessment.impact}</li>
          </ul>
        </div>

        <details className="aha-raw-input">
          <summary>完整参数</summary>
          <pre>{JSON.stringify(rawInput, null, 2)}</pre>
        </details>

        <label className="aha-check-row">
          <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
          我已阅读以上影响说明
        </label>

        {error && <p className="aha-modal-error" role="alert">{error}</p>}

        <div className="aha-modal-actions">
          <button type="button" className="aha-btn aha-btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="aha-btn aha-btn-danger-solid"
            disabled={!read || busy}
            onClick={onConfirm}
            title={!read ? '勾选「我已阅读」后才能确认' : undefined}
          >
            {busy ? '处理中…' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  );
}
