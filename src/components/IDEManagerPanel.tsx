// IDEManagerPanel — settings panel for managing AI IDE backends.
// Real data from the main-process IdeRegistry (detection + persisted
// default); Hermes/Pi are catalog stubs shown as 即将支持.

import { useCallback, useEffect, useState } from 'react';
import { Check, Download, Settings, Star } from 'lucide-react';
import type { IdeRegistryState } from '../types';

export function IDEManagerPanel() {
  const [state, setState] = useState<IdeRegistryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await window.vibeMeet.ideRegistry.list();
      if (res.ok) {
        setState(res.state);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSetDefault = async (id: string) => {
    setBusy(id);
    try {
      const res = await window.vibeMeet.ideRegistry.setDefault(id);
      if (!res.ok) setError(res.error ?? '设为默认失败');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const ides = state?.ides ?? [];
  const installedIdes = ides.filter((ide) => ide.installed);
  const upcomingIdes = ides.filter((ide) => !ide.installed);
  const defaultIde = ides.find((ide) => ide.id === state?.defaultIdeId && ide.installed);

  return (
    <section className="ide-manager-panel">
      <div className="ide-manager-header">
        <h2 className="ide-manager-title">IDE 管理</h2>
        <p className="ide-manager-desc">
          管理用于独立编辑器窗口的 AI IDE。点击数字员工的"详情"按钮时，将使用默认 IDE 打开编辑器。
        </p>
      </div>

      {error && <div className="ide-manager-empty">加载失败：{error}</div>}

      {/* Current default */}
      {defaultIde && (
        <div className="ide-manager-current">
          <div className="ide-manager-current-label">当前默认 IDE</div>
          <div className="ide-manager-ide-card ide-manager-ide-card-default">
            <div className="ide-manager-ide-icon">
              <Star size={20} />
            </div>
            <div className="ide-manager-ide-info">
              <div className="ide-manager-ide-name">{defaultIde.displayName}</div>
              <div className="ide-manager-ide-desc">{defaultIde.description}</div>
            </div>
            <div className="ide-manager-ide-badge ui-badge ui-badge-accent">默认</div>
          </div>
        </div>
      )}

      {/* Installed IDEs */}
      <div className="ide-manager-section">
        <div className="ide-manager-section-title">已安装 IDE</div>
        {installedIdes.length === 0 ? (
          <div className="ide-manager-empty">暂无已安装 IDE</div>
        ) : (
          <div className="ide-manager-list">
            {installedIdes.map((ide) => (
              <div key={ide.id} className="ide-manager-ide-card">
                <div className="ide-manager-ide-icon">
                  <Settings size={20} />
                </div>
                <div className="ide-manager-ide-info">
                  <div className="ide-manager-ide-name">
                    {ide.displayName}
                    {ide.version && (
                      <span className="ide-manager-ide-version"> v{ide.version}</span>
                    )}
                  </div>
                  <div className="ide-manager-ide-desc">{ide.description}</div>
                </div>
                {ide.id === state?.defaultIdeId ? (
                  <div className="ide-manager-ide-badge ui-badge ui-badge-accent">默认</div>
                ) : (
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    onClick={() => void handleSetDefault(ide.id)}
                    disabled={busy === ide.id}
                  >
                    设为默认
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Upcoming IDEs */}
      <div className="ide-manager-section">
        <div className="ide-manager-section-title">即将支持</div>
        {upcomingIdes.length === 0 ? (
          <div className="ide-manager-empty">暂无</div>
        ) : (
          <div className="ide-manager-list">
            {upcomingIdes.map((ide) => (
              <div key={ide.id} className="ide-manager-ide-card">
                <div className="ide-manager-ide-icon">
                  <Download size={20} />
                </div>
                <div className="ide-manager-ide-info">
                  <div className="ide-manager-ide-name">{ide.displayName}</div>
                  <div className="ide-manager-ide-desc">{ide.description}</div>
                </div>
                <button type="button" className="ui-btn ui-btn-sm" disabled>
                  即将支持
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="ide-manager-info">
        <Check size={14} />
        <span>OpenCode 已内置打包，无需额外安装。Hermes Agent 和 Pi Agent 将在后续版本支持。</span>
      </div>
    </section>
  );
}
