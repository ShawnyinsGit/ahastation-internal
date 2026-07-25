// BackendSettings.tsx — per-CLI-backend auth configuration panel.
//
// Displays a horizontal tab bar with one tab per registered CLI backend
// (Claude Code, Codex, Kimi, Qoder, plus any custom backends). Selecting a
// tab shows that backend's auth config card — API key, base URL, model
// selector, default toggle, and an install button for unavailable backends.
// Includes a "+" button to add custom CLI backends.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BackendInfo, CustomBackendInfo } from '../types';

interface CustomBackendFormData {
  id: string;
  displayName: string;
  binaryName: string;
  apiKeyEnv: string;
  baseUrlEnv: string;
  defaultModel: string;
  installHint: string;
  npmPackage: string;
}

const emptyCustomForm: CustomBackendFormData = {
  id: '',
  displayName: '',
  binaryName: '',
  apiKeyEnv: '',
  baseUrlEnv: '',
  defaultModel: '',
  installHint: '',
  npmPackage: '',
};

export function BackendSettings() {
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [customBackends, setCustomBackends] = useState<CustomBackendInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingApiKey, setEditingApiKey] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<string | null>(null);
  // Install state — one backend at a time.
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState('');
  const [installTarget, setInstallTarget] = useState<string | null>(null);
  // Custom backend form state
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customForm, setCustomForm] = useState<CustomBackendFormData>(emptyCustomForm);
  const [customFormError, setCustomFormError] = useState<string | null>(null);
  const [customFormSaving, setCustomFormSaving] = useState(false);
  // OAuth login state
  const [loginStatus, setLoginStatus] = useState<Record<string, 'idle' | 'pending' | 'done' | 'error'>>({});
  const [loginError, setLoginError] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, customList] = await Promise.all([
        window.vibeMeet.backendAuth.list(),
        window.vibeMeet.customBackend.list(),
      ]);
      setBackends(list);
      setCustomBackends(customList);
      // Auto-select the default backend tab on first load, or keep the current
      // selection if it still exists.
      setActiveTab((prev) => {
        if (prev && list.some((b) => b.id === prev)) return prev;
        const def = list.find((b) => b.isDefault);
        return def?.id ?? list[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSetApiKey = useCallback(async (backendId: string) => {
    const key = editingApiKey[backendId] ?? '';
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setApiKey(backendId, key);
      if (!r.ok) {
        setError(r.error ?? 'Failed to save API key');
      } else {
        setEditingApiKey((e) => { const next = { ...e }; delete next[backendId]; return next; });
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [editingApiKey, reload]);

  const handleSetBaseUrl = useCallback(async (backendId: string, url: string) => {
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setBaseUrl(backendId, url);
      if (!r.ok) {
        setError(r.error ?? 'Failed to save base URL');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [reload]);

  const handleSetModel = useCallback(async (backendId: string, model: string) => {
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setModel(backendId, model);
      if (!r.ok) {
        setError(r.error ?? 'Failed to save model');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [reload]);

  const handleSetAvatar = useCallback(async (backendId: string, dataUrl: string | null) => {
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setAvatar(backendId, dataUrl);
      if (!r.ok) {
        setError(r.error ?? 'Failed to save avatar');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [reload]);

  const handleSetDefault = useCallback(async (backendId: string) => {
    setSaving((s) => ({ ...s, [backendId]: true }));
    try {
      const r = await window.vibeMeet.backendAuth.setDefault(backendId);
      if (!r.ok) {
        setError(r.error ?? 'Failed to set default');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, [backendId]: false }));
    }
  }, [reload]);

  const handleSetClaudeCliSource = useCallback(async (source: 'bundled' | 'system') => {
    setSaving((s) => ({ ...s, 'claude-code': true }));
    try {
      const r = await window.vibeMeet.backendAuth.setClaudeCliSource(source);
      if (!r.ok) {
        setError(r.error ?? 'Failed to set Claude CLI source');
      } else {
        await reload();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving((s) => ({ ...s, 'claude-code': false }));
    }
  }, [reload]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, backendId: string) => {
    if (e.key === 'Enter') {
      void handleSetApiKey(backendId);
    }
  }, [handleSetApiKey]);

  const handleInstall = useCallback(async (backendId: string) => {
    if (installing) return;
    setInstalling(backendId);
    setInstallTarget(backendId);
    setInstallLog('');
    const unsubscribe = window.vibeMeet.backendAuth.onInstallProgress((event) => {
      if (event.backendId === backendId) {
        setInstallLog((prev) => prev + event.data);
      }
    });
    try {
      const res = await window.vibeMeet.backendAuth.install(backendId);
      if (res.ok) {
        setInstallLog((prev) => prev + '\n✓ 安装成功 · Installed successfully.\n');
        await reload();
      } else {
        setInstallLog((prev) => prev + `\n✗ ${res.error ?? '安装失败'}\n`);
      }
    } catch (err) {
      setInstallLog((prev) => prev + `\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      unsubscribe();
      setInstalling(null);
    }
  }, [installing, reload]);

  const handleLoginOAuth = useCallback(async (backendId: string) => {
    setLoginStatus((s) => ({ ...s, [backendId]: 'pending' }));
    setLoginError((e) => { const next = { ...e }; delete next[backendId]; return next; });
    try {
      let res: { ok: boolean; error?: string };
      if (backendId === 'claude-code') {
        res = await window.vibeMeet.auth.loginSubscription();
      } else {
        res = await window.vibeMeet.backendAuth.loginOAuth(backendId);
      }
      if (res.ok) {
        setLoginStatus((s) => ({ ...s, [backendId]: 'done' }));
        await reload();
      } else {
        setLoginStatus((s) => ({ ...s, [backendId]: 'error' }));
        setLoginError((e) => ({ ...e, [backendId]: res.error ?? 'Login failed' }));
      }
    } catch (err) {
      setLoginStatus((s) => ({ ...s, [backendId]: 'error' }));
      setLoginError((e) => ({ ...e, [backendId]: err instanceof Error ? err.message : String(err) }));
    }
  }, [reload]);

  const handleCheckAuth = useCallback(async (backendId: string) => {
    setLoginStatus((s) => ({ ...s, [backendId]: 'pending' }));
    const result = await window.vibeMeet.backendAuth.checkStatus(backendId);
    if (result.ok && result.loggedIn) {
      setLoginStatus((s) => ({ ...s, [backendId]: 'done' }));
      setLoginError((e) => { const next = { ...e }; delete next[backendId]; return next; });
      await reload();
    } else {
      setLoginStatus((s) => ({ ...s, [backendId]: 'error' }));
      setLoginError((e) => ({ ...e, [backendId]: result.error ?? '尚未检测到有效登录，请先在 Terminal 完成认证。' }));
    }
  }, [reload]);

  // Custom backend form handlers
  const handleCustomFormChange = useCallback((field: keyof CustomBackendFormData, value: string) => {
    setCustomForm((prev) => ({ ...prev, [field]: value }));
  }, []);

  const handleAddCustomBackend = useCallback(async () => {
    setCustomFormError(null);
    setCustomFormSaving(true);
    try {
      const result = await window.vibeMeet.customBackend.add({
        id: customForm.id,
        displayName: customForm.displayName,
        binaryName: customForm.binaryName,
        apiKeyEnv: customForm.apiKeyEnv || undefined,
        baseUrlEnv: customForm.baseUrlEnv || undefined,
        defaultModel: customForm.defaultModel || undefined,
        installHint: customForm.installHint || undefined,
        npmPackage: customForm.npmPackage || undefined,
      });
      if (result.ok) {
        setShowCustomForm(false);
        setCustomForm(emptyCustomForm);
        await reload();
        // Auto-select the newly added backend
        setActiveTab(result.entry.id);
      } else {
        setCustomFormError(result.error);
      }
    } catch (err) {
      setCustomFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomFormSaving(false);
    }
  }, [customForm, reload]);

  const handleRemoveCustomBackend = useCallback(async (id: string) => {
    if (!window.confirm('确定要删除这个自定义后端吗？')) return;
    try {
      const result = await window.vibeMeet.customBackend.remove(id);
      if (result.ok) {
        await reload();
        // If the removed backend was active, clear selection (reload will pick first available)
        setActiveTab((prev) => prev === id ? null : prev);
      } else {
        setError(result.error ?? '删除失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [reload]);

  const activeBackend = useMemo(
    () => backends.find((b) => b.id === activeTab) ?? null,
    [backends, activeTab],
  );

  if (loading) {
    return <div className="backend-settings-loading">加载中…</div>;
  }

  return (
    <div className="backend-settings">
      <div className="drawer-settings-row">
        <div className="drawer-settings-label">
          <div className="drawer-settings-title">后端管理 · Backends</div>
          <div className="drawer-settings-hint">
            配置各 CLI 后端的认证信息。已认证的后端可作为会议 Host 使用。
          </div>
        </div>
      </div>

      {error && (
        <div className="backend-settings-error">
          <span>✕ {error}</span>
          <button type="button" className="backend-settings-error-dismiss" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      {/* Tab bar */}
      <div className="backend-tabs" role="tablist" aria-label="后端选择">
        {backends.map((b) => {
          const hasAuth = b.loggedIn;
          const isActive = b.id === activeTab;
          const isCustom = b.id.startsWith('custom-');
          return (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={`backend-tab ${isActive ? 'backend-tab-active' : ''}`}
              onClick={() => setActiveTab(b.id)}
            >
              <span className="backend-tab-label">{b.displayName}</span>
              {b.isDefault && <span className="backend-tab-default">默认</span>}
              {!b.available && <span className="backend-tab-dot unavailable" />}
              {hasAuth && b.available && <span className="backend-tab-dot ok" />}
              {isCustom && (
                <span
                  className="backend-tab-custom-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleRemoveCustomBackend(b.id);
                  }}
                  title="删除此自定义后端"
                >
                  ×
                </span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className={`backend-tab backend-tab-add ${showCustomForm ? 'backend-tab-active' : ''}`}
          onClick={() => setShowCustomForm(!showCustomForm)}
          title="添加自定义 CLI 后端"
        >
          <span className="backend-tab-label">＋ 新增</span>
        </button>
      </div>

      {/* Custom backend form */}
      {showCustomForm && (
        <div className="custom-backend-form">
          <div className="custom-backend-form-header">
            <div className="custom-backend-form-title">新增自定义 CLI 后端</div>
            <button
              type="button"
              className="custom-backend-form-close"
              onClick={() => {
                setShowCustomForm(false);
                setCustomForm(emptyCustomForm);
                setCustomFormError(null);
              }}
            >
              ×
            </button>
          </div>
          {customFormError && (
            <div className="custom-backend-form-error">✕ {customFormError}</div>
          )}
          <div className="custom-backend-form-fields">
            <div className="backend-field">
              <label className="backend-field-label">ID (唯一标识)</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.id}
                onChange={(e) => handleCustomFormChange('id', e.target.value)}
                placeholder="my-cli"
                disabled={customFormSaving}
              />
            </div>
            <div className="backend-field">
              <label className="backend-field-label">显示名称</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.displayName}
                onChange={(e) => handleCustomFormChange('displayName', e.target.value)}
                placeholder="My CLI"
                disabled={customFormSaving}
              />
            </div>
            <div className="backend-field">
              <label className="backend-field-label">命令名称 (二进制文件)</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.binaryName}
                onChange={(e) => handleCustomFormChange('binaryName', e.target.value)}
                placeholder="my-cli"
                disabled={customFormSaving}
              />
            </div>
            <div className="backend-field">
              <label className="backend-field-label">API Key 环境变量名 (可选)</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.apiKeyEnv}
                onChange={(e) => handleCustomFormChange('apiKeyEnv', e.target.value)}
                placeholder="MY_API_KEY"
                disabled={customFormSaving}
              />
            </div>
            <div className="backend-field">
              <label className="backend-field-label">Base URL 环境变量名 (可选)</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.baseUrlEnv}
                onChange={(e) => handleCustomFormChange('baseUrlEnv', e.target.value)}
                placeholder="MY_BASE_URL"
                disabled={customFormSaving}
              />
            </div>
            <div className="backend-field">
              <label className="backend-field-label">默认模型 (可选)</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.defaultModel}
                onChange={(e) => handleCustomFormChange('defaultModel', e.target.value)}
                placeholder="default-model"
                disabled={customFormSaving}
              />
            </div>
            <div className="backend-field">
              <label className="backend-field-label">npm 包名 (可选)</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.npmPackage}
                onChange={(e) => handleCustomFormChange('npmPackage', e.target.value)}
                placeholder="@scope/my-cli"
                disabled={customFormSaving}
              />
            </div>
            <div className="backend-field">
              <label className="backend-field-label">安装提示 (可选)</label>
              <input
                className="backend-field-input"
                type="text"
                value={customForm.installHint}
                onChange={(e) => handleCustomFormChange('installHint', e.target.value)}
                placeholder="npm install -g @scope/my-cli"
                disabled={customFormSaving}
              />
            </div>
          </div>
          <div className="custom-backend-form-actions">
            <button
              type="button"
              className="backend-btn"
              onClick={handleAddCustomBackend}
              disabled={customFormSaving || !customForm.id || !customForm.displayName || !customForm.binaryName}
            >
              {customFormSaving ? '添加中…' : '添加'}
            </button>
            <button
              type="button"
              className="backend-btn backend-btn-secondary"
              onClick={() => {
                setShowCustomForm(false);
                setCustomForm(emptyCustomForm);
                setCustomFormError(null);
              }}
              disabled={customFormSaving}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Active tab content */}
      {activeBackend && (
        <BackendCard
          key={activeBackend.id}
          backend={activeBackend}
          editingApiKey={editingApiKey[activeBackend.id] ?? ''}
          saving={saving[activeBackend.id] ?? false}
          installing={installing}
          installLog={installTarget === activeBackend.id ? installLog : ''}
          loginStatus={loginStatus[activeBackend.id] ?? 'idle'}
          loginError={loginError[activeBackend.id]}
          onApiKeyChange={(val) => setEditingApiKey((e) => ({ ...e, [activeBackend.id]: val }))}
          onSaveApiKey={() => handleSetApiKey(activeBackend.id)}
          onSaveBaseUrl={(url) => handleSetBaseUrl(activeBackend.id, url)}
          onSaveModel={(model) => handleSetModel(activeBackend.id, model)}
          onSetDefault={() => handleSetDefault(activeBackend.id)}
          onSetClaudeCliSource={handleSetClaudeCliSource}
          onInstall={() => handleInstall(activeBackend.id)}
          onLoginOAuth={() => handleLoginOAuth(activeBackend.id)}
          onCheckAuth={() => handleCheckAuth(activeBackend.id)}
          onAvatarChange={(dataUrl) => handleSetAvatar(activeBackend.id, dataUrl)}
          onKeyDown={(e) => handleKeyDown(e, activeBackend.id)}
        />
      )}
    </div>
  );
}

interface BackendCardProps {
  backend: BackendInfo;
  editingApiKey: string;
  saving: boolean;
  installing: string | null;
  installLog: string;
  loginStatus: 'idle' | 'pending' | 'done' | 'error';
  loginError: string | undefined;
  onApiKeyChange: (val: string) => void;
  onSaveApiKey: () => void;
  onSaveBaseUrl: (url: string) => void;
  onSaveModel: (model: string) => void;
  onSetDefault: () => void;
  onSetClaudeCliSource: (source: 'bundled' | 'system') => void;
  onInstall: () => void;
  onLoginOAuth: () => void;
  onCheckAuth: () => void;
  onAvatarChange: (dataUrl: string | null) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

function BackendCard({
  backend: b,
  editingApiKey,
  saving,
  installing,
  installLog,
  loginStatus,
  loginError,
  onApiKeyChange,
  onSaveApiKey,
  onSaveBaseUrl,
  onSaveModel,
  onSetDefault,
  onSetClaudeCliSource,
  onInstall,
  onLoginOAuth,
  onCheckAuth,
  onAvatarChange,
  onKeyDown,
}: BackendCardProps) {
  const hasAuth = b.hasApiKey || b.loggedIn;
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleAvatarFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onAvatarChange(reader.result);
      }
    };
    reader.readAsDataURL(file);
  }, [onAvatarChange]);

  return (
    <div className={`backend-card ${b.isDefault ? 'backend-card-default' : ''} ${!b.available ? 'backend-card-unavailable' : ''}`}>
      <div className="backend-card-header">
        <div className="backend-card-icon" title="点击更换头像">
          {b.customAvatar ? (
            <img src={b.customAvatar} alt={b.displayName} className="backend-card-avatar-custom" />
          ) : (
            <BackendIcon iconId={b.iconId} />
          )}
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleAvatarFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="backend-card-avatar-btn"
            onClick={() => avatarInputRef.current?.click()}
            title="更换头像"
          >
            ✎
          </button>
          {b.customAvatar && (
            <button
              type="button"
              className="backend-card-avatar-remove-btn"
              onClick={() => onAvatarChange(null)}
              title="移除自定义头像"
            >
              ✕
            </button>
          )}
        </div>
        <div className="backend-card-info">
          <div className="backend-card-name">{b.displayName}</div>
          <div className="backend-card-status">
            <span className={`backend-status-dot ${hasAuth ? 'status-ok' : 'status-none'}`} />
            {hasAuth ? '已配置' : '未配置'}
            {b.isDefault && <span className="backend-default-badge">默认</span>}
            {!b.available && <span className="backend-unavailable-badge">未安装</span>}
          </div>
        </div>
        <div className="backend-card-actions">
          {!b.isDefault && b.available && b.supportsCoordinator && (
            <button
              type="button"
              className="backend-btn backend-btn-sm"
              onClick={onSetDefault}
              disabled={saving}
            >
              设为默认
            </button>
          )}
          {!b.supportsCoordinator && (
            <span className="backend-unavailable-badge">仅专家</span>
          )}
        </div>
      </div>

      {b.available && (
        <div className="backend-card-body">
          <div className="backend-field">
            <label className="backend-field-label">API Key</label>
            <div className="backend-field-row">
              <input
                className="backend-field-input"
                type="password"
                value={editingApiKey}
                onChange={(e) => onApiKeyChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  b.hasApiKey
                    ? '已保存 (输入新值覆盖)'
                    : b.id === 'codex'
                      ? 'OpenAI 或第三方兼容 API Key'
                      : '输入 API Key'
                }
                disabled={saving}
              />
              <button
                type="button"
                className="backend-btn backend-btn-sm"
                onClick={onSaveApiKey}
                disabled={saving || editingApiKey.length === 0}
              >
                {saving ? '…' : '保存'}
              </button>
            </div>
          </div>

          <div className="backend-field">
            <label className="backend-field-label">Base URL</label>
            <input
              className="backend-field-input"
              type="text"
              defaultValue={b.baseUrl ?? ''}
              onBlur={(e) => {
                if (e.target.value !== (b.baseUrl ?? '')) {
                  onSaveBaseUrl(e.target.value);
                }
              }}
              placeholder={
                b.id === 'codex'
                  ? '留空用 OpenAI 官方；第三方网关填 https://.../v1'
                  : 'https://api.example.com/v1'
              }
              disabled={saving}
            />
          </div>

          {b.id === 'codex' && (
            <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.75 }}>
              支持 OpenAI 官方 Key，或通过 Base URL 接入第三方 OpenAI 兼容网关；OAuth 登录与 API Key 二选一即可。
            </p>
          )}

          {b.id === 'claude-code' && (
            <div className="backend-field">
              <label className="backend-field-label">CLI 来源</label>
              <select
                className="backend-field-select"
                value={b.claudeCodeCliSource ?? 'system'}
                onChange={(e) => onSetClaudeCliSource(e.target.value as 'bundled' | 'system')}
                disabled={saving}
              >
                <option value="system" disabled={b.systemClaudeAvailable === false}>
                  系统 PATH {b.systemClaudeVersion ? `(v${b.systemClaudeVersion})` : b.systemClaudeAvailable ? '(已安装)' : '(未找到)'}
                </option>
                <option value="bundled" disabled={b.bundledClaudeAvailable === false}>
                  内置版本 {b.bundledClaudeVersion ? `(v${b.bundledClaudeVersion})` : b.bundledClaudeAvailable ? '(已安装)' : '(不可用)'}
                </option>
              </select>
              <p style={{ margin: '4px 0 0', fontSize: 12, opacity: 0.75 }}>
                {b.workerRuntimeState === 'version-incompatible' || b.workerRuntimeState === 'diagnostic-failed'
                  ? b.workerRuntimeReason
                  : b.version
                    ? `当前 Worker 使用 v${b.version}`
                    : 'Worker 运行时版本未知'}
              </p>
            </div>
          )}

          <div className="backend-field">
            <label className="backend-field-label">Model</label>
            {/* Codex keeps free-text so third-party model IDs work; models are suggestions. */}
            {b.id !== 'codex' && b.models && b.models.length > 0 ? (
              <select
                className="backend-field-select"
                defaultValue={b.model ?? b.defaultModel ?? ''}
                onChange={(e) => onSaveModel(e.target.value)}
                disabled={saving}
              >
                <option value="">默认 ({b.defaultModel ?? 'auto'})</option>
                {b.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <>
                <input
                  className="backend-field-input"
                  type="text"
                  list={b.models && b.models.length > 0 ? `${b.id}-model-suggestions` : undefined}
                  defaultValue={b.model ?? ''}
                  onBlur={(e) => {
                    if (e.target.value !== (b.model ?? '')) {
                      onSaveModel(e.target.value);
                    }
                  }}
                  placeholder={
                    b.id === 'codex'
                      ? '留空则使用 Codex CLI 默认模型；可填 gpt-5.4 / glm-5.2 等'
                      : (b.defaultModel ?? '默认模型')
                  }
                  disabled={saving}
                />
                {b.models && b.models.length > 0 && (
                  <datalist id={`${b.id}-model-suggestions`}>
                    {b.models.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                )}
              </>
            )}
          </div>

          {/* OAuth login section for supported backends */}
          {(b.id === 'claude-code' || b.id === 'kimi' || b.id === 'codex' || b.id === 'qoder') && (
            <div className="backend-field">
              <label className="backend-field-label">
                OAuth 登录
                {b.loggedIn && <span className="backend-status-dot status-ok" style={{ marginLeft: 6 }} />}
              </label>
              <button
                type="button"
                className="backend-btn backend-btn-sm backend-btn-login"
                onClick={onLoginOAuth}
                disabled={loginStatus === 'pending'}
              >
                {loginStatus === 'pending' ? '正在打开浏览器…'
                  : loginStatus === 'done' ? '已登录 ✓'
                  : b.loggedIn ? '重新认证'
                  : `使用 ${b.displayName} 登录`}
              </button>
              <button
                type="button"
                className="backend-btn backend-btn-sm"
                onClick={onCheckAuth}
                disabled={loginStatus === 'pending'}
                style={{ marginLeft: 8 }}
              >
                检查登录状态
              </button>
              {loginStatus === 'error' && loginError && (
                <div className="backend-settings-error" style={{ marginTop: 4, fontSize: 12 }}>✕ {loginError}</div>
              )}
            </div>
          )}

          <div className="backend-card-caps">
            {b.supportsMcp && <span className="backend-cap-badge">MCP</span>}
            {b.supportsPermissions && <span className="backend-cap-badge">权限流</span>}
          </div>
        </div>
      )}

      {!b.available && b.installHint && (
        <div className="backend-card-install">
          <code>{b.installHint}</code>
          {b.installHint !== 'Bundled with AhaStation' && (
            <button
              type="button"
              className="backend-btn backend-install-btn"
              onClick={onInstall}
              disabled={installing !== null}
            >
              {installing === b.id ? '安装中…' : `安装 ${b.displayName}`}
            </button>
          )}
          {installLog && (
            <pre className="backend-install-log">{installLog}</pre>
          )}
        </div>
      )}

      {/* Install log persists after success when backend becomes available */}
      {b.available && installLog && (
        <div className="backend-card-install">
          <pre className="backend-install-log">{installLog}</pre>
        </div>
      )}
    </div>
  );
}

function BackendIcon({ iconId }: { iconId: string }) {
  switch (iconId) {
    case 'claude':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h-2v-6h2v6zm4 0h-2v-6h2v6zm0-8H9V7h6v2z"/>
        </svg>
      );
    case 'codex':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
        </svg>
      );
    case 'kimi':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3zM5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/>
        </svg>
      );
    case 'qoder':
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M7 5h10v2H7V5zm0 4h10v2H7V9zm0 4h7v2H7v-2zm-4 6l4-4v3h10v2H3v-1z"/>
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <circle cx="12" cy="12" r="10"/>
        </svg>
      );
  }
}
