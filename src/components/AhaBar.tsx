import { useCallback, useEffect, useRef, useState } from 'react';
import { Pin, PinOff, X } from 'lucide-react';
import type { AhaBarState } from '../types';
import { VirtualKeyboard } from './VirtualKeyboard';

const HOVER_ENTER_MS = 200;
const HOVER_LEAVE_MS = 400;

const EMPTY: AhaBarState = {
  sessionId: null,
  cwd: null,
  projectName: null,
  runningCount: 0,
  pending: [],
  topPending: null,
  hardwareTakenOver: false,
};

/** Compact → hover → pinned ambient bar. Lives in the floating companion
 *  BrowserWindow (view=ahabar). Approvals go straight to the orchestrator
 *  via ahabar:resolve-permission; high-risk jumps back to the meeting card. */
export function AhaBar() {
  const [state, setState] = useState<AhaBarState>(EMPTY);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  const enterTimer = useRef<number | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('ahabar-view');
    document.title = 'AhaBar';
    return () => document.documentElement.classList.remove('ahabar-view');
  }, []);

  useEffect(() => {
    const api = window.vibeMeet.ahabar;
    if (!api) return;
    void api.getState().then((res) => {
      if (res.ok) setState(res.state);
    });
    return api.onEvent(setState);
  }, []);

  const expanded = pinned || hovered;
  const pendingCount = state.pending.length;

  useEffect(() => {
    void window.vibeMeet.ahabar?.setExpanded(expanded);
  }, [expanded]);

  const onEnter = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    enterTimer.current = window.setTimeout(() => setHovered(true), HOVER_ENTER_MS);
  };

  const onLeave = () => {
    if (enterTimer.current) window.clearTimeout(enterTimer.current);
    if (pinned) return;
    leaveTimer.current = window.setTimeout(() => setHovered(false), HOVER_LEAVE_MS);
  };

  const resolve = useCallback(async (id: string, decision: 'allow' | 'deny') => {
    await window.vibeMeet.ahabar?.resolvePermission(id, decision);
  }, []);

  const focusMain = useCallback(() => {
    void window.vibeMeet.ahabar?.focusMain();
  }, []);

  const close = () => {
    // Closing from inside = destroy the floating window via main toggle.
    // There is no dedicated close IPC; the main window owns the toggle, so
    // we ask main to focus and the user can re-toggle — or use window.close.
    window.close();
  };

  return (
    <div
      className={`ahabar-root${expanded ? ' is-expanded' : ''}${pinned ? ' is-pinned' : ''}${pendingCount ? ' has-pending' : ''}`}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <header className="ahabar-pill" onDoubleClick={focusMain}>
        <span className="ahabar-dot" aria-hidden />
        <strong className="ahabar-running">{state.runningCount} 运行中</strong>
        {pendingCount > 0 && (
          <span className="ahabar-pending-badge" title="待批准">
            ⚠ {pendingCount} 待批准
          </span>
        )}
        {state.projectName && (
          <span className="ahabar-project" title={state.cwd ?? ''}>{state.projectName}</span>
        )}
        <div className="ahabar-actions">
          <button
            type="button"
            className="ahabar-icon-btn"
            title={pinned ? '取消固定' : '固定展开'}
            onClick={() => setPinned((v) => !v)}
          >
            {pinned ? <PinOff size={12} /> : <Pin size={12} />}
          </button>
          <button type="button" className="ahabar-icon-btn" title="关闭" onClick={close}>
            <X size={12} />
          </button>
        </div>
      </header>

      {expanded && (
        <section className="ahabar-card">
          {state.topPending ? (
            <>
              <div className="ahabar-card-row">
                <span className="ahabar-card-label">客户端</span>
                <span>{state.topPending.hostId}</span>
              </div>
              <div className="ahabar-card-row">
                <span className="ahabar-card-label">工具</span>
                <span>{state.topPending.toolName}</span>
              </div>
              <div className="ahabar-card-row">
                <span className="ahabar-card-label">目标</span>
                <span className="ahabar-card-target">{state.topPending.target}</span>
              </div>
              <div className="ahabar-card-row">
                <span className="ahabar-card-label">风险</span>
                <span className={`ahabar-risk is-${state.topPending.risk}`}>
                  {state.topPending.risk === 'low' ? '低' : state.topPending.risk === 'mid' ? '中' : '高'}
                </span>
              </div>
            </>
          ) : (
            <p className="ahabar-card-empty">没有待批准的操作</p>
          )}

          <VirtualKeyboard
            topPending={state.topPending}
            hardwareTakenOver={state.hardwareTakenOver}
            onApprove={(id) => { void resolve(id, 'allow'); }}
            onDeny={(id) => { void resolve(id, 'deny'); }}
            onFocusMain={focusMain}
          />
        </section>
      )}
    </div>
  );
}
