import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { Compass, Mic } from 'lucide-react';

export type AppViewMode = 'meeting' | 'tasks';

interface AppTopBarProps {
  viewMode: AppViewMode;
  onChangeViewMode: (mode: AppViewMode) => void;
  /** 待处理（待批准 + 待验收）数量——任务视图切换钮上的角标。 */
  attendCount: number;
  /** 设置入口（齿轮 + 弹层），由 App 传入现有 SettingsMenu。 */
  settingsSlot?: ReactNode;
  /** 探索页入口（P6，占位版）。 */
  onOpenExplore?: () => void;
}

/**
 * AhaStudio 顶栏（04 文档 §9.1）：视图切换器永远可见，会议/任务两个视图
 * 共享同一份任务真相、切换不丢状态。AhaTalk 路径与额度为占位胶囊（M3-7 /
 * M8-1 后端未建，标「开发中」徽章）。
 */
export const AppTopBar = memo(function AppTopBar({ viewMode, onChangeViewMode, attendCount, settingsSlot, onOpenExplore }: AppTopBarProps) {
  const [pathOpen, setPathOpen] = useState(false);
  const [quotaOpen, setQuotaOpen] = useState(false);
  const pathRef = useRef<HTMLDivElement>(null);
  const quotaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pathOpen && !quotaOpen) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (pathRef.current && !pathRef.current.contains(t)) setPathOpen(false);
      if (quotaRef.current && !quotaRef.current.contains(t)) setQuotaOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pathOpen, quotaOpen]);

  return (
    <header className="aha-topbar">
      <span className="aha-topbar-brand">AhaStudio</span>

      {/* 视图切换器：永远可见，切换不丢状态（04 §8.2 导航规则） */}
      <div className="aha-view-switch" role="tablist" aria-label="视图切换">
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'meeting'}
          className={`aha-view-switch-btn${viewMode === 'meeting' ? ' active' : ''}`}
          onClick={() => onChangeViewMode('meeting')}
        >
          会议
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={viewMode === 'tasks'}
          className={`aha-view-switch-btn${viewMode === 'tasks' ? ' active' : ''}`}
          onClick={() => onChangeViewMode('tasks')}
        >
          任务
          {attendCount > 0 && <span className="aha-view-switch-badge aha-tnum">{attendCount}</span>}
        </button>
      </div>

      <div className="aha-topbar-spacer" />

      {/* AhaTalk 处理路径（M3-7 占位：本地路径真实，Key/Cloud 未建） */}
      <div className="aha-chip-wrap" ref={pathRef}>
        <button
          type="button"
          className="aha-chip"
          onClick={() => { setPathOpen((v) => !v); setQuotaOpen(false); }}
          title="AhaTalk 处理路径 · 自有 Key / Cloud 开发中"
        >
          <span className="aha-chip-dot aha-chip-dot-run" />
          <span>AhaTalk · 本地</span>
          <span className="aha-chip-caret">▾</span>
        </button>
        {pathOpen && (
          <div className="aha-pop" role="menu">
            <div className="aha-pop-item aha-pop-item-active">
              <span>本地</span>
              <small>· 不上传内容</small>
              <span className="aha-pop-check">✓</span>
            </div>
            <div className="aha-pop-item aha-pop-item-disabled">
              <span>自有 Key</span>
              <small>· 直连你的模型服务</small>
              <span className="aha-dev-tag">开发中</span>
            </div>
            <div className="aha-pop-item aha-pop-item-disabled">
              <span>AhaTalk Cloud</span>
              <small>· 托管处理</small>
              <span className="aha-dev-tag">开发中</span>
            </div>
          </div>
        )}
      </div>

      {/* 额度（M8-1 占位：采集后端未建） */}
      <div className="aha-chip-wrap" ref={quotaRef}>
        <button
          type="button"
          className="aha-chip"
          onClick={() => { setQuotaOpen((v) => !v); setPathOpen(false); }}
          title="额度与 Capacity Forecast · 开发中"
        >
          <span className="aha-chip-dot aha-chip-dot-quota" />
          <span className="aha-tnum">额度</span>
          <span className="aha-dev-tag">开发中</span>
        </button>
        {quotaOpen && (
          <div className="aha-pop aha-pop-wide">
            <div className="aha-pop-title">Quota Window · Capacity Forecast</div>
            <p className="aha-pop-desc">
              各客户端用量、重置时间与余量预测（M8-1 / M8-2）正在建设中。
              上线后此处展示逐客户端额度条与「预计还可完成 N 个任务 · 置信度」。
            </p>
            <div className="aha-pop-item aha-pop-item-disabled">
              <span>窗口预热（Pro）</span>
              <span className="aha-dev-tag">开发中</span>
            </div>
          </div>
        )}
      </div>

      {onOpenExplore && (
        <button type="button" className="aha-icon-btn" onClick={onOpenExplore} title="探索" aria-label="探索">
          <Compass size={16} />
        </button>
      )}
      <span className="aha-icon-btn aha-icon-btn-static" title="按住说话（底栏麦克风）" aria-hidden>
        <Mic size={16} />
      </span>
      {settingsSlot}
    </header>
  );
});
