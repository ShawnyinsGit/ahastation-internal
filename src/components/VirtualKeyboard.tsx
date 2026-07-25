import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, CornerDownLeft, Mic, X } from 'lucide-react';
import type { AhaBarPending, ApprovalGesture } from '../types';

const HOLD_MS = 800;

interface VirtualKeyboardProps {
  topPending: AhaBarPending | null;
  hardwareTakenOver: boolean;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onFocusMain: () => void;
}

const RISK_HINT: Record<ApprovalGesture, string> = {
  low: '单击批准',
  mid: '按住 800ms 批准',
  high: '高风险 · 回主窗口确认',
};

export function VirtualKeyboard({
  topPending,
  hardwareTakenOver,
  onApprove,
  onDeny,
  onFocusMain,
}: VirtualKeyboardProps) {
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimer = useRef<number | null>(null);
  const holdRaf = useRef<number | null>(null);
  const holdStarted = useRef(0);

  const clearHold = useCallback(() => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    if (holdRaf.current) window.cancelAnimationFrame(holdRaf.current);
    holdTimer.current = null;
    holdRaf.current = null;
    setHoldProgress(0);
  }, []);

  useEffect(() => () => clearHold(), [clearHold]);
  useEffect(() => { clearHold(); }, [topPending?.id, clearHold]);

  if (hardwareTakenOver) {
    return (
      <div className="ahabar-vk is-hardware">
        <span>已由实体键接管</span>
      </div>
    );
  }

  if (!topPending) return null;

  const risk = topPending.risk;

  const startHold = () => {
    if (risk !== 'mid') return;
    clearHold();
    holdStarted.current = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - holdStarted.current) / HOLD_MS);
      setHoldProgress(p);
      if (p < 1) holdRaf.current = window.requestAnimationFrame(tick);
    };
    holdRaf.current = window.requestAnimationFrame(tick);
    holdTimer.current = window.setTimeout(() => {
      clearHold();
      onApprove(topPending.id);
    }, HOLD_MS);
  };

  const handleApprovePointerDown = () => {
    if (risk === 'high') {
      onFocusMain();
      return;
    }
    if (risk === 'low') {
      onApprove(topPending.id);
      return;
    }
    startHold();
  };

  return (
    <div className="ahabar-vk" aria-label="虚拟键盘">
      <p className="ahabar-vk-target">
        <strong>{topPending.toolName}</strong>
        <span>{topPending.target}</span>
        <em className={`ahabar-risk is-${risk}`}>{RISK_HINT[risk]}</em>
      </p>
      <div className="ahabar-vk-keys">
        <button type="button" className="ahabar-key" title="语音（回主窗口）" onClick={onFocusMain}>
          <Mic size={16} />
          <span>语音</span>
        </button>
        <button
          type="button"
          className={`ahabar-key ahabar-key-approve is-${risk}`}
          title={RISK_HINT[risk]}
          onPointerDown={handleApprovePointerDown}
          onPointerUp={clearHold}
          onPointerLeave={clearHold}
          onPointerCancel={clearHold}
        >
          {risk === 'mid' && (
            <i
              className="ahabar-hold-ring"
              style={{ '--hold': String(holdProgress) } as CSSProperties}
              aria-hidden
            />
          )}
          <Check size={16} />
          <span>批准</span>
        </button>
        <button
          type="button"
          className="ahabar-key ahabar-key-deny"
          title="拒绝"
          onClick={() => onDeny(topPending.id)}
        >
          <X size={16} />
          <span>拒绝</span>
        </button>
        <button type="button" className="ahabar-key" title="回到主窗口" onClick={onFocusMain}>
          <CornerDownLeft size={16} />
          <span>返回</span>
        </button>
      </div>
    </div>
  );
}
