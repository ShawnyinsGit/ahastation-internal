import { useState, useRef, useEffect } from 'react';
import { Activity, Globe, Terminal, FileText, X, Plus, SquareArrowOutUpRight } from 'lucide-react';
import type { StageWindow, StageWindowType } from '../lib/stage-window-store';
import { requestHideBrowser } from '../lib/browser-store';

interface StageTabBarProps {
  windows: StageWindow[];
  activeWindowId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: (type: StageWindowType) => void;
  onPopOut?: (id: string) => void;
}

const ACTIVITY_TAB_ID = 'activity-default';

const ICON_MAP: Record<StageWindowType, typeof Globe> = {
  activity: Activity,
  browser: Globe,
  terminal: Terminal,
  file: FileText,
};

export function StageTabBar({
  windows,
  activeWindowId,
  onSelect,
  onClose,
  onCreate,
  onPopOut,
}: StageTabBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [menuOpen]);

  // Hide browser WebContentsView when the "+" dropdown opens, because the
  // native OS view paints ON TOP of all renderer HTML (z-index is irrelevant).
  useEffect(() => {
    if (!menuOpen) return;
    return requestHideBrowser();
  }, [menuOpen]);

  const handleCreate = (type: StageWindowType) => {
    onCreate(type);
    setMenuOpen(false);
  };

  return (
    <div className="stage-tab-bar">
      <div className="stage-tab-list">
        {windows.map((win) => {
          const Icon = ICON_MAP[win.type];
          const isActivity = win.id === ACTIVITY_TAB_ID;
          return (
            <div
              key={win.id}
              className={`stage-tab ${win.id === activeWindowId ? 'stage-tab-active' : ''}`}
              onClick={() => onSelect(win.id)}
            >
              <span className="stage-tab-icon">
                <Icon size={14} />
              </span>
              <span className="stage-tab-title">{win.title}</span>
              {!isActivity && onPopOut && (
                <button
                  type="button"
                  className="stage-tab-popout"
                  onClick={(e) => { e.stopPropagation(); onPopOut(win.id); }}
                  aria-label="独立窗口打开"
                  title="在新窗口中打开"
                >
                  <SquareArrowOutUpRight size={11} />
                </button>
              )}
              {!isActivity && (
                <button
                  type="button"
                  className="stage-tab-close"
                  onClick={(e) => { e.stopPropagation(); onClose(win.id); }}
                  aria-label="关闭"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="stage-tab-add" ref={menuRef}>
        <button
          type="button"
          className="stage-tab-add-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="新建窗口"
          title="新建窗口"
        >
          <Plus size={16} />
        </button>
        {menuOpen && (
          <div className="stage-tab-menu">
            <button
              type="button"
              className="stage-tab-menu-item"
              onClick={() => handleCreate('browser')}
            >
              <Globe size={14} />
              <span>新建浏览器</span>
            </button>
            <button
              type="button"
              className="stage-tab-menu-item"
              onClick={() => handleCreate('terminal')}
            >
              <Terminal size={14} />
              <span>新建终端</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
