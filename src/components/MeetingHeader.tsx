import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatElapsed } from '../hooks/useTimer';
import type { AutoApproveScope } from '../types';

export type MeetingView = 'meeting' | 'tasks';

interface MeetingHeaderProps {
  cwd: string | null;
  elapsed: number;
  autoApproveScope: AutoApproveScope;
  onChangeAutoApproveScope: (scope: AutoApproveScope) => void;
  multiAgent: boolean;
  onToggleMultiAgent: () => void;
  view: MeetingView;
  onChangeView: (view: MeetingView) => void;
  /** Tasks parked on the user across all projects. Drives the switcher badge. */
  attentionCount: number;
  // Settings entry (gear + popover). Chat-drawer toggle and Leave button live
  // on the BottomToolbar — keeping them only there avoids duplicate controls.
  settingsSlot?: ReactNode;
}

const SCOPE_LABELS: Record<AutoApproveScope, string> = {
  off: '自动批准',
  read: '仅读取',
  all: '全部',
};

export function MeetingHeader({
  cwd,
  elapsed,
  autoApproveScope,
  onChangeAutoApproveScope,
  multiAgent,
  onToggleMultiAgent,
  view,
  onChangeView,
  attentionCount,
  settingsSlot,
}: MeetingHeaderProps) {
  // Folder name + status dot live on the TabStrip above; the header only
  // surfaces the full cwd path so there is exactly one identity per surface.
  const isOn = autoApproveScope !== 'off';
  const multiAgentTitle = multiAgent
    ? '多 Agent 并行已开启 · 所有需求会先评估依赖再拆解并行 · 点击关闭'
    : '单 Agent 模式 · 点击开启多 Agent 并行';

  // Scope selector popover
  const [scopePickerOpen, setScopePickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const handleToggleClick = useCallback(() => {
    if (isOn) {
      // Clicking an active scope turns it off
      onChangeAutoApproveScope('off');
      setScopePickerOpen(false);
    } else {
      // Open scope picker
      setScopePickerOpen((v) => !v);
    }
  }, [isOn, onChangeAutoApproveScope]);

  const handlePickScope = useCallback(
    (scope: AutoApproveScope) => {
      onChangeAutoApproveScope(scope);
      setScopePickerOpen(false);
    },
    [onChangeAutoApproveScope],
  );

  // Close picker on outside click
  useEffect(() => {
    if (!scopePickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && e.target instanceof Node && !pickerRef.current.contains(e.target)) {
        setScopePickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [scopePickerOpen]);

  const approveTitle = isOn
    ? `自动批准: ${SCOPE_LABELS[autoApproveScope]} · 点击关闭`
    : '手动批准 · 点击选择自动批准范围';

  return (
    <header className="mtg-header">
      <div className="mtg-header-left">
        <div className="mtg-title-path" title={cwd ?? ''}>{cwd ?? 'No folder'}</div>
      </div>
      <div className="mtg-header-mid">
        <div className="mtg-view-switch" role="tablist" aria-label="视图切换">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'meeting'}
            className={view === 'meeting' ? 'is-active' : ''}
            onClick={() => onChangeView('meeting')}
          >
            会议
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'tasks'}
            className={view === 'tasks' ? 'is-active' : ''}
            onClick={() => onChangeView('tasks')}
          >
            任务
            {attentionCount > 0 && (
              <span className="mtg-view-switch-badge" aria-label={`${attentionCount} 项待处理`}>
                {attentionCount}
              </span>
            )}
          </button>
        </div>
        <div className="mtg-header-center">
          <span className="mtg-timer-dot" />
          <span className="mtg-timer">{formatElapsed(elapsed)}</span>
        </div>
      </div>
      <div className="mtg-header-right">
        <button
          type="button"
          className={`mtg-approve-toggle mtg-multi-toggle ${multiAgent ? 'mtg-multi-toggle-on' : ''}`}
          role="switch"
          aria-checked={multiAgent}
          onClick={onToggleMultiAgent}
          title={multiAgentTitle}
        >
          <span className="mtg-approve-toggle-track" aria-hidden="true">
            <span className="mtg-approve-toggle-knob" />
          </span>
          <span className="mtg-approve-toggle-label">多 Agent 并行</span>
        </button>
        <div className="mtg-scope-wrap" ref={pickerRef}>
          <button
            type="button"
            className={`mtg-approve-toggle ${isOn ? 'mtg-approve-toggle-on' : ''}`}
            role="switch"
            aria-checked={isOn}
            onClick={handleToggleClick}
            title={approveTitle}
          >
            <span className="mtg-approve-toggle-track" aria-hidden="true">
              <span className="mtg-approve-toggle-knob" />
            </span>
            <span className="mtg-approve-toggle-label">
              {isOn ? `自动批准: ${SCOPE_LABELS[autoApproveScope]}` : '自动批准'}
            </span>
          </button>
          {scopePickerOpen && (
            <div className="mtg-scope-picker">
              <div className="mtg-scope-picker-title">选择自动批准范围</div>
              <button
                type="button"
                className={`mtg-scope-option ${autoApproveScope === 'read' ? 'mtg-scope-option-active' : ''}`}
                onClick={() => handlePickScope('read')}
              >
                <span className="mtg-scope-option-label">仅读取</span>
                <span className="mtg-scope-option-desc">Read, Grep, Glob 等安全工具自动通过</span>
              </button>
              <button
                type="button"
                className={`mtg-scope-option ${autoApproveScope === 'all' ? 'mtg-scope-option-active' : ''}`}
                onClick={() => handlePickScope('all')}
              >
                <span className="mtg-scope-option-label">全部</span>
                <span className="mtg-scope-option-desc">所有工具（含 Write, Bash）自动通过</span>
              </button>
            </div>
          )}
        </div>
        {settingsSlot}
      </div>
    </header>
  );
}
