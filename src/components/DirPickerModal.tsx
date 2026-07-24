// DirPickerModal.tsx — in-app directory picker for handheld mode.
//
// The native GTK open-directory dialog overflows 800px-tall handheld screens
// (Open/Cancel get clipped), so handheld mode browses directories with this
// modal instead. It only replaces the BROWSING half of the flow: picking a
// directory still routes through window.vibeMeet.confirmCwd(), which shows
// the same grant-confirmation messagebox as the native dialog:pick-cwd path.
//
// usePickCwd() is the drop-in replacement for window.vibeMeet.pickCwd() at
// the four callsites (TabStrip / JoinScreen ×2 / Lobby): desktop mode keeps
// the native dialog, handheld mode opens this modal. Render `pickerModal`
// somewhere in the component's JSX.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Folder, X } from 'lucide-react';
import { useHandheldMode } from '../lib/handheld-mode';

interface DirPickerModalProps {
  initialPath: string | null;
  onSelect: (path: string) => void;
  onCancel: () => void;
}

interface DirRow {
  name: string;
  path: string;
}

function breadcrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean);
  const crumbs = [{ label: '/', path: '/' }];
  parts.forEach((part, i) => {
    crumbs.push({ label: part, path: '/' + parts.slice(0, i + 1).join('/') });
  });
  return crumbs;
}

export function DirPickerModal({ initialPath, onSelect, onCancel }: DirPickerModalProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirRow[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async (path: string | null, hidden: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.vibeMeet.listDir(path, hidden);
      if (res.ok) {
        setCurrentPath(res.path);
        setParent(res.parent);
        setEntries(res.entries);
      } else {
        setError(res.error);
        setEntries([]);
      }
    } catch {
      setError('无法读取该目录');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath, false);
    // Only the initial mount loads; afterwards navigation drives load().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc cancels, same as dismissing the native dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const navigate = useCallback(
    (path: string | null) => {
      void load(path, showHidden);
    },
    [load, showHidden],
  );

  const toggleHidden = useCallback(() => {
    const next = !showHidden;
    setShowHidden(next);
    void load(currentPath, next);
  }, [load, currentPath, showHidden]);

  // Selecting still goes through the main-process grant confirmation. If the
  // user cancels that messagebox the modal stays open so they can pick a
  // different directory instead.
  const choose = useCallback(async () => {
    if (!currentPath || confirming) return;
    setConfirming(true);
    try {
      const granted = await window.vibeMeet.confirmCwd(currentPath);
      if (granted) onSelect(granted);
    } finally {
      setConfirming(false);
    }
  }, [currentPath, confirming, onSelect]);

  return (
    <div className="dirpicker-backdrop" onClick={onCancel}>
      <div
        className="dirpicker"
        role="dialog"
        aria-modal="true"
        aria-label="选择工作目录"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dirpicker-head">
          <span className="dirpicker-title">选择工作目录</span>
          <button
            type="button"
            className="dirpicker-close"
            onClick={onCancel}
            aria-label="取消"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="dirpicker-nav">
          <button
            type="button"
            className="dirpicker-up"
            onClick={() => navigate(parent)}
            disabled={parent === null || loading}
            aria-label="上一级目录"
          >
            <ArrowUp size={16} aria-hidden="true" />
            <span>上一级</span>
          </button>
          <div className="dirpicker-crumbs">
            {currentPath !== null &&
              breadcrumbs(currentPath).map((crumb, i, all) => (
                <span key={crumb.path} className="dirpicker-crumb-wrap">
                  {i > 0 && <span className="dirpicker-crumb-sep">/</span>}
                  <button
                    type="button"
                    className={`dirpicker-crumb${i === all.length - 1 ? ' dirpicker-crumb-current' : ''}`}
                    onClick={() => navigate(crumb.path)}
                    disabled={loading}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}
          </div>
          <button
            type="button"
            className={`dirpicker-hidden-toggle${showHidden ? ' dirpicker-hidden-toggle-on' : ''}`}
            onClick={toggleHidden}
            aria-pressed={showHidden}
          >
            显示隐藏
          </button>
        </div>

        <div className="dirpicker-list">
          {loading ? (
            <div className="dirpicker-status">加载中…</div>
          ) : error ? (
            <div className="dirpicker-status dirpicker-error">{error}</div>
          ) : entries.length === 0 ? (
            <div className="dirpicker-status">没有子目录</div>
          ) : (
            entries.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="dirpicker-row"
                onClick={() => navigate(entry.path)}
              >
                <Folder size={18} aria-hidden="true" />
                <span className="dirpicker-row-name">{entry.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="dirpicker-foot">
          <button type="button" className="dirpicker-btn dirpicker-btn-cancel" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="dirpicker-btn dirpicker-btn-primary"
            onClick={() => { void choose(); }}
            disabled={currentPath === null || loading || confirming}
          >
            {confirming ? '确认中…' : '选择此目录'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PickCwdRequest {
  initialPath: string | null;
  resolve: (path: string | null) => void;
}

/** Mode-aware cwd picker: handheld → in-app DirPickerModal, desktop → the
 *  native dialog. The returned promise resolves with the picked path or
 *  null (cancelled), exactly like window.vibeMeet.pickCwd(). */
export function usePickCwd(): {
  pickCwd: (initialPath?: string) => Promise<string | null>;
  pickerModal: ReactNode;
} {
  const { mode } = useHandheldMode();
  const [request, setRequest] = useState<PickCwdRequest | null>(null);
  const requestRef = useRef<PickCwdRequest | null>(null);
  requestRef.current = request;

  const pickCwd = useCallback(
    (initialPath?: string): Promise<string | null> => {
      if (mode !== 'handheld') return window.vibeMeet.pickCwd();
      // Only one picker at a time; a second call resolves the first as
      // cancelled rather than stacking modals.
      requestRef.current?.resolve(null);
      return new Promise<string | null>((resolve) => {
        setRequest({ initialPath: initialPath ?? null, resolve });
      });
    },
    [mode],
  );

  const close = useCallback((path: string | null) => {
    setRequest((req) => {
      req?.resolve(path);
      return null;
    });
  }, []);

  const pickerModal = request ? (
    <DirPickerModal
      initialPath={request.initialPath}
      onSelect={(path) => close(path)}
      onCancel={() => close(null)}
    />
  ) : null;

  return { pickCwd, pickerModal };
}
