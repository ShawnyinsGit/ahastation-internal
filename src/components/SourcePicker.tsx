import { useCallback, useEffect, useState } from 'react';
import { X, Lock, RefreshCw, RotateCw } from 'lucide-react';
import type { DesktopSource } from '../types';
import { errorMessage } from '../lib/format-error';

interface SourcePickerProps {
  open: boolean;
  onClose: () => void;
  onPick: (source: DesktopSource) => void;
}

type PermStatus = 'not-determined' | 'denied' | 'restricted' | 'unknown';
type PickerError = { kind: 'permission'; status: PermStatus } | { kind: 'other'; message: string };

function asPermStatus(s: string | undefined): PermStatus {
  if (s === 'not-determined' || s === 'denied' || s === 'restricted') return s;
  return 'unknown';
}

export function SourcePicker({ open, onClose, onPick }: SourcePickerProps) {
  const [sources, setSources] = useState<DesktopSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PickerError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSources([]);
    try {
      const res = await window.vibeMeet.getDesktopSources();
      if (!res.ok) {
        const status = asPermStatus(res.status);
        if (res.error === 'permission-needed' || res.error === 'permission-denied' || status !== 'unknown') {
          setError({ kind: 'permission', status });
        } else {
          setError({ kind: 'other', message: res.error });
        }
        return;
      }
      setSources(res.sources);
    } catch (err: unknown) {
      setError({ kind: 'other', message: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  // Auto re-check when the window regains focus while the permission pane is
  // showing — covers the common path of "user clicks Open System Settings,
  // grants permission, alt-tabs back to AhaStation". Without this, the pane
  // would still be stale and the user has to click "Try again" themselves.
  useEffect(() => {
    if (!open) return;
    if (error?.kind !== 'permission') return;
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [open, error, load]);

  const openSettings = useCallback(() => {
    void window.vibeMeet.openScreenSettings();
  }, []);

  const relaunch = useCallback(() => {
    void window.vibeMeet.relaunchApp();
  }, []);

  if (!open) return null;

  // macOS only applies a newly-granted Screen Recording permission to
  // processes started *after* the grant, so a relaunch is required when the
  // app previously hit a real denial. On first-launch (not-determined) the
  // OS will usually raise its own prompt and no relaunch is needed.
  const needsRelaunch = error?.kind === 'permission' && error.status === 'denied';

  return (
    <div className="picker-backdrop" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span>选择要共享给 Claude 的画面</span>
          <button className="picker-close" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>

        {error?.kind === 'permission' && (
          <div className="picker-permission">
            <div className="picker-permission-icon" aria-hidden="true"><Lock size={28} /></div>
            <div className="picker-permission-title">
              {error.status === 'not-determined'
                ? 'macOS 需要授权 AhaStation 录制屏幕'
                : '屏幕录制权限被拒绝'}
            </div>
            <div className="picker-permission-text">
              {error.status === 'not-determined' ? (
                <>
                  系统正在弹出授权请求。如果没看到，可手动打开
                  <b> 系统设置 → 隐私与安全性 → 屏幕录制</b>，
                  勾选 <b>AhaStation</b>，再回到这里继续。
                </>
              ) : (
                <>
                  打开 <b>系统设置 → 隐私与安全性 → 屏幕录制</b>，
                  勾选 <b>AhaStation</b>，然后
                  <b> 重新启动 AhaStation</b>。
                  macOS 要求重启应用后新授权才会生效。
                </>
              )}
            </div>
            <ol className="picker-permission-steps">
              <li>点 <b>打开系统设置</b>，跳到「屏幕录制」面板。</li>
              <li>在列表里找到 <b>AhaStation</b>，把开关打开（如未出现，先关掉这个弹窗再重新点共享屏幕，让 macOS 注册一次）。</li>
              <li>{needsRelaunch ? '点下方「重启 AhaStation」让新权限生效。' : '切回 AhaStation，会自动检测并继续。'}</li>
            </ol>
            <div className="picker-permission-actions">
              <button className="picker-btn picker-btn-primary" onClick={openSettings}>
                打开系统设置
              </button>
              {needsRelaunch && (
                <button className="picker-btn picker-btn-relaunch" onClick={relaunch}>
                  <RotateCw size={13} aria-hidden="true" />
                  <span>重启 AhaStation</span>
                </button>
              )}
              <button className="picker-btn" onClick={load}>
                <RefreshCw size={13} aria-hidden="true" />
                <span>重新检测</span>
              </button>
            </div>
          </div>
        )}

        {error?.kind === 'other' && (
          <div className="picker-error">
            <div>{error.message}</div>
            <button className="picker-btn" onClick={load}>Retry</button>
          </div>
        )}

        {!error && loading && <div className="picker-loading">Loading sources…</div>}

        {!error && !loading && (
          <div className="picker-grid">
            {sources.length === 0 ? (
              <div className="picker-empty">No sources found.</div>
            ) : (
              sources.map((s) => (
                <button key={s.id} className="picker-item" onClick={() => { onPick(s); onClose(); }}>
                  <img src={s.thumbnail} alt={s.name} />
                  <div className="picker-item-name" title={s.name}>{s.name}</div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
