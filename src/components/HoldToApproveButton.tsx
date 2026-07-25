import { useCallback, useEffect, useRef, useState } from 'react';

interface HoldToApproveButtonProps {
  onApprove: () => void;
  disabled?: boolean;
  /** 按住时长，默认 800ms（03 §2.5 --dur-hold）。 */
  holdMs?: number;
  label?: string;
}

/**
 * 中风险按住批准按钮（03 §3.3）：进度环绕左侧圆点 + 按钮底色同步填充
 * 双通道；走满瞬间弹性放大变绿；中途松开 150ms 回弹归零——
 * 「没按住 = 没发生」。键盘等价：聚焦后按住 Enter/Space 同样有效。
 */
export function HoldToApproveButton({
  onApprove,
  disabled = false,
  holdMs = 800,
  label = '按住批准',
}: HoldToApproveButtonProps) {
  const [progress, setProgress] = useState(0); // 0..1
  const [done, setDone] = useState(false);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const holdingRef = useRef(false);
  const doneRef = useRef(false);

  const cancelRaf = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const tick = useCallback(
    (now: number) => {
      if (!holdingRef.current) return;
      const p = Math.min(1, (now - startRef.current) / holdMs);
      setProgress(p);
      if (p >= 1) {
        holdingRef.current = false;
        doneRef.current = true;
        setDone(true);
        onApprove();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    },
    [holdMs, onApprove],
  );

  const startHold = useCallback(() => {
    if (disabled || doneRef.current) return;
    holdingRef.current = true;
    startRef.current = performance.now();
    cancelRaf();
    rafRef.current = requestAnimationFrame(tick);
  }, [disabled, tick]);

  const endHold = useCallback(() => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    cancelRaf();
    // 150ms 回弹归零（03：给用户「已取消」的明确反馈）
    setProgress(0);
  }, []);

  useEffect(() => () => cancelRaf(), []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
      e.preventDefault();
      startHold();
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      endHold();
    }
  };

  const deg = Math.round(progress * 360);

  return (
    <button
      type="button"
      className={`aha-hold-btn${done ? ' aha-hold-btn-done' : ''}${progress > 0 ? ' aha-hold-btn-holding' : ''}`}
      disabled={disabled}
      onPointerDown={startHold}
      onPointerUp={endHold}
      onPointerLeave={endHold}
      onPointerCancel={endHold}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      style={{
        // 双通道：环形进度 + 底色填充（--aha-attend 15% 透明度 → 100%）
        background: done
          ? undefined
          : `linear-gradient(to right, var(--aha-attend-soft) ${progress * 100}%, transparent ${progress * 100}%)`,
      }}
      aria-label={`${label}（按住 ${holdMs}ms）`}
    >
      <span
        className="aha-hold-ring"
        aria-hidden
        style={{
          background: done
            ? 'var(--aha-run)'
            : `conic-gradient(var(--aha-attend) ${deg}deg, var(--aha-border-subtle) ${deg}deg)`,
        }}
      />
      <span className="aha-hold-label">{done ? '✓ 已批准' : label}</span>
    </button>
  );
}
