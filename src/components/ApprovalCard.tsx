import { useEffect, useMemo, useRef, useState } from 'react';
import type { PendingPermission } from '../types';
import { assessRisk, RISK_BADGE_CLASS, RISK_LABELS } from '../lib/risk-classify';
import { BackendAvatar } from './BackendAvatar';
import { HoldToApproveButton } from './HoldToApproveButton';
import { ApprovalDetailModal } from './ApprovalDetailModal';

type DecideResult = Promise<{ ok: true } | { ok: false; error: string }> | void;

interface ApprovalCardProps {
  pending: PendingPermission;
  /** 四要素之「客户端/任务」：发起方名称（Worker 标题或 Coordinator）。 */
  owner: string;
  /** 发起方后端 id（渲染客户端图标）。 */
  backendId?: string;
  /** 四要素之「项目」。 */
  project: string;
  onDecide: (id: string, decision: 'allow' | 'deny') => DecideResult;
  resolving?: boolean;
  error?: string | null;
}

const UNDO_WINDOW_MS = 5000;

/**
 * 统一批准卡片（04 BR-A / 03 §4.2）：四要素缺一不渲染，按风险级路由
 * 控件——低单击 / 中按住 800ms / 高与禁止快捷进 P5 详情二次确认。
 * 拒绝后原位变「已拒绝 · 撤销」，5 秒倒计时细环（03 改进建议 6.10），
 * 倒计时内可撤销；超时才真正下发拒绝。
 */
export function ApprovalCard({
  pending,
  owner,
  backendId,
  project,
  onDecide,
  resolving,
  error,
}: ApprovalCardProps) {
  const assessment = useMemo(() => assessRisk(pending.toolName, pending.input), [pending]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [denied, setDenied] = useState(false);
  const [undoLeft, setUndoLeft] = useState(0); // 0..1 剩余比例
  const [localBusy, setLocalBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const denyTimerRef = useRef<number | null>(null);
  const undoRafRef = useRef<number | null>(null);
  const denyAtRef = useRef(0);

  const busy = localBusy || Boolean(resolving);
  const shownError = error ?? localError;

  const clearUndo = () => {
    if (denyTimerRef.current !== null) window.clearTimeout(denyTimerRef.current);
    if (undoRafRef.current !== null) cancelAnimationFrame(undoRafRef.current);
    denyTimerRef.current = null;
    undoRafRef.current = null;
  };

  useEffect(() => clearUndo, []);

  const submit = async (decision: 'allow' | 'deny') => {
    setLocalBusy(true);
    setLocalError(null);
    try {
      const res = await onDecide(pending.id, decision);
      if (res && !res.ok) setLocalError(res.error);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalBusy(false);
    }
  };

  const handleAllow = () => {
    setDetailOpen(false);
    void submit('allow');
  };

  // 拒绝：先进入 5 秒可撤销窗口（BR-A6 / 03 §4.2），超时后才真正下发
  const handleDeny = () => {
    if (denied) return;
    setDenied(true);
    denyAtRef.current = performance.now();
    const tick = (now: number) => {
      const left = Math.max(0, 1 - (now - denyAtRef.current) / UNDO_WINDOW_MS);
      setUndoLeft(left);
      if (left > 0) undoRafRef.current = requestAnimationFrame(tick);
    };
    undoRafRef.current = requestAnimationFrame(tick);
    denyTimerRef.current = window.setTimeout(() => {
      clearUndo();
      void submit('deny');
    }, UNDO_WINDOW_MS);
  };

  const handleUndo = () => {
    clearUndo();
    setDenied(false);
    setUndoLeft(0);
  };

  const undoDeg = Math.round(undoLeft * 360);
  const needsDetail = assessment.level === 'high' || assessment.level === 'blocked';
  const iconId = (() => {
    switch (backendId) {
      case 'claude-code': return 'claude';
      case 'codex': return 'codex';
      case 'kimi': return 'kimi';
      case 'qoder': return 'qoder';
      default: return backendId;
    }
  })();

  if (denied) {
    return (
      <div className="aha-approval aha-approval-denied" role="status">
        <span className="aha-approval-denied-label">已拒绝</span>
        <button type="button" className="aha-undo-btn" onClick={handleUndo}>
          <span
            className="aha-undo-ring"
            aria-hidden
            style={{ background: `conic-gradient(var(--aha-text-tertiary) ${undoDeg}deg, var(--aha-border-subtle) ${undoDeg}deg)` }}
          />
          撤销
          <span className="aha-tnum">{Math.ceil((undoLeft * UNDO_WINDOW_MS) / 1000)}s</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`aha-approval aha-approval-${assessment.level}`}
      role="group"
      aria-label={`${RISK_LABELS[assessment.level]}权限请求：${pending.toolName}`}
    >
      {/* 1. 谁在请求 */}
      <div className="aha-approval-head">
        {iconId && <BackendAvatar iconId={iconId} size={20} />}
        <span className="aha-approval-owner">{owner}</span>
        <span className="aha-approval-crumb">{project}</span>
        <span className={`aha-risk-badge ${RISK_BADGE_CLASS[assessment.level]}`}>
          {assessment.level === 'blocked' ? '⚠ ' : ''}{RISK_LABELS[assessment.level]}
        </span>
      </div>

      {/* 2. 请求什么 */}
      <div className="aha-approval-action">
        <span className="aha-approval-action-label">请求动作：</span>
        <span className="aha-approval-action-text">
          {assessment.action}
          {assessment.target && <code className="aha-mono"> {assessment.target}</code>}
        </span>
      </div>

      {/* 3. 代价是什么 */}
      <p className="aha-approval-impact">{assessment.impact}</p>

      {shownError && <p className="aha-approval-error" role="alert">{shownError}</p>}

      {/* 4. 怎么办 */}
      <div className="aha-approval-actions">
        <button type="button" className="aha-btn aha-btn-ghost-danger" disabled={busy} onClick={handleDeny}>
          拒绝
        </button>
        {assessment.level === 'low' && (
          <button type="button" className="aha-btn aha-btn-primary" disabled={busy} onClick={handleAllow}>
            {busy ? '处理中…' : '批准'}
          </button>
        )}
        {assessment.level === 'mid' && (
          <HoldToApproveButton disabled={busy} onApprove={handleAllow} />
        )}
        {needsDetail && (
          <button
            type="button"
            className="aha-btn aha-btn-detail"
            disabled={busy}
            onClick={() => setDetailOpen(true)}
          >
            需进入详情 →
          </button>
        )}
      </div>

      <ApprovalDetailModal
        open={detailOpen}
        project={project}
        task={owner}
        client={backendId ?? owner}
        assessment={assessment}
        rawInput={pending.input}
        blocked={assessment.level === 'blocked'}
        busy={busy}
        error={shownError}
        onConfirm={handleAllow}
        onCancel={() => setDetailOpen(false)}
      />
    </div>
  );
}
