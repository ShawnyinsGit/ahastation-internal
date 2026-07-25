import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Activity, ChevronDown, Clock, DownloadCloud, FolderOpen, KeyRound, LogIn, Mic, MonitorUp } from 'lucide-react';
import { meetingStore } from '../lib/meeting-store';
import type { BackendInfo } from '../types';

interface LobbyProps {
  lastError?: string | null;
}

interface RecoverableMeeting {
  meetingId: string;
  seq: number;
  state: Record<string, unknown>;
}

interface DeviceSnapshot {
  platform: string;
  arch: string;
  kernel: string;
  totalMemoryBytes: number;
  electronVersion: string;
  sessionType: string;
  gpu: { available: boolean; status: Record<string, string> };
  audio: {
    microphone: 'granted' | 'denied' | 'available' | 'unavailable' | 'unknown';
    speaker: 'available' | 'unknown';
    whisper: boolean;
  };
  workspace: { git: boolean; worktree: boolean; version: string | null };
  capacity: { hosts: number; workers: number };
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function shortPath(cwd: string): { label: string; parent: string } {
  const parts = cwd.split('/').filter(Boolean);
  const label = parts[parts.length - 1] ?? cwd;
  const parent = parts.slice(0, -1).join('/');
  return { label, parent: parent ? `/${parent}/` : '/' };
}

/** Get auth status label for a backend. */
function backendAuthLabel(b: BackendInfo): string {
  if (b.loggedIn) return '✓';
  return '';
}

function microphoneLabel(status: DeviceSnapshot['audio']['microphone']): string {
  switch (status) {
    case 'granted': return '已授权';
    case 'denied': return '被拒绝';
    case 'available': return '可用';
    case 'unavailable': return '未检测到';
    default: return '进入会议后测试';
  }
}

export function Lobby({ lastError }: LobbyProps) {
  const lobby = useSyncExternalStore(meetingStore.subscribeTabs, meetingStore.getLobbyData);

  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [selectedBackend, setSelectedBackend] = useState('codex');
  const [authOpen, setAuthOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DeviceSnapshot | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);

  // Per-backend auth editing state
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [modelInput, setModelInput] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Claude-specific OAuth state
  const [loginStatus, setLoginStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [loginError, setLoginError] = useState<string>('');

  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableMeeting[]>([]);

  // Install state — one backend at a time; log accumulates streamed output.
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState('');

  // Load backends on mount
  const reloadBackends = useCallback(async () => {
    try {
      const list = await window.vibeMeet.backendAuth.list();
      setBackends(list);
      // Find the default backend, fallback to codex
      const defaultBe = list.find((b) => b.isDefault);
      const fallback = list.find((b) => b.id === 'codex');
      const selected = defaultBe?.id ?? fallback?.id ?? list[0]?.id ?? 'codex';
      setSelectedBackend(selected);
      meetingStore.defaultBackendId = selected;
    } catch (err) {
      console.warn('[Lobby] failed to load backends:', err);
    }
  }, []);

  useEffect(() => {
    void reloadBackends();
    void window.vibeMeet.sessions.listRecoverable()
      .then((result) => setRecoverable(result.meetings))
      .catch((error) => console.warn('[Lobby] failed to load recoverable meetings:', error));
  }, [reloadBackends]);

  // When selected backend changes, prefill inputs from its config
  useEffect(() => {
    const b = backends.find((x) => x.id === selectedBackend);
    if (b) {
      setBaseUrlInput(b.baseUrl ?? '');
      setModelInput(b.model ?? '');
    }
  }, [selectedBackend, backends]);

  const currentBackend = useMemo(
    () => backends.find((b) => b.id === selectedBackend) ?? null,
    [backends, selectedBackend],
  );

  const openCwd = useCallback(async (cwd: string) => {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      const res = await meetingStore.openSession(cwd);
      if (!res.ok) setOpenError(res.error ?? 'Failed to open meeting');
    } finally {
      setOpening(false);
    }
  }, [opening]);

  const pickAndOpen = useCallback(async () => {
    const dir = await window.vibeMeet.pickCwd();
    if (!dir) return;
    await openCwd(dir);
  }, [openCwd]);

  const recoverMeeting = useCallback(async (meeting: RecoverableMeeting) => {
    if (opening) return;
    const cwd = typeof meeting.state.cwd === 'string' ? meeting.state.cwd : '';
    if (!cwd) return;
    setOpening(true);
    setOpenError(null);
    try {
      const result = await meetingStore.openSession(cwd, '', meeting.meetingId);
      if (!result.ok) setOpenError(result.error ?? 'Failed to recover meeting');
      else setRecoverable((items) => items.filter((item) => item.meetingId !== meeting.meetingId));
    } finally {
      setOpening(false);
    }
  }, [opening]);

  const handleBackendChange = useCallback(async (backendId: string) => {
    const result = await window.vibeMeet.backendAuth.setDefault(backendId);
    if (!result.ok) {
      setOpenError(result.error ?? 'This backend cannot coordinate');
      await reloadBackends();
      return;
    }
    setSelectedBackend(backendId);
    meetingStore.defaultBackendId = backendId;
    await reloadBackends();
  }, [reloadBackends]);

  const saveApiKey = useCallback(async () => {
    if (!currentBackend) return;
    setApiKeyStatus('saving');
    const key = apiKeyInputs[currentBackend.id] ?? '';
    const res = await window.vibeMeet.backendAuth.setApiKey(currentBackend.id, key);
    if (res.ok) {
      setApiKeyStatus('saved');
      setApiKeyInputs((prev) => ({ ...prev, [currentBackend.id]: '' }));
      setTimeout(() => setApiKeyStatus('idle'), 2000);
      await reloadBackends();
    } else {
      setApiKeyStatus('error');
    }
  }, [currentBackend, apiKeyInputs, reloadBackends]);

  const saveBaseUrl = useCallback(async (url: string) => {
    if (!currentBackend) return;
    await window.vibeMeet.backendAuth.setBaseUrl(currentBackend.id, url);
    await reloadBackends();
  }, [currentBackend, reloadBackends]);

  const saveModel = useCallback(async (model: string) => {
    if (!currentBackend) return;
    await window.vibeMeet.backendAuth.setModel(currentBackend.id, model);
    await reloadBackends();
  }, [currentBackend, reloadBackends]);

  const loginSubscription = useCallback(async () => {
    setLoginStatus('pending');
    setLoginError('');
    const res = await window.vibeMeet.auth.loginSubscription();
    if (res.ok) {
      setLoginStatus('done');
      await reloadBackends();
    } else {
      setLoginStatus('error');
      setLoginError(res.error ?? 'Login failed');
    }
  }, [reloadBackends]);

  const loginOAuth = useCallback(async (backendId: string) => {
    setLoginStatus('pending');
    setLoginError('');
    const res = await window.vibeMeet.backendAuth.loginOAuth(backendId);
    if (res.ok) {
      setLoginStatus('done');
      await reloadBackends();
    } else {
      setLoginStatus('error');
      setLoginError(res.error ?? 'Login failed');
    }
  }, [reloadBackends]);

  const installBackend = useCallback(async (backendId: string) => {
    if (installing) return;
    setInstalling(backendId);
    setInstallLog('');
    // Subscribe before invoking — the main process begins emitting progress
    // events as soon as the subprocess starts, and we don't want to miss the
    // first few lines.
    const unsubscribe = window.vibeMeet.backendAuth.onInstallProgress((event) => {
      if (event.backendId === backendId) {
        setInstallLog((prev) => prev + event.data);
      }
    });
    try {
      const res = await window.vibeMeet.backendAuth.install(backendId);
      if (res.ok) {
        setInstallLog((prev) => prev + '\n✓ Installed successfully.\n');
        await reloadBackends();
      } else {
        setInstallLog((prev) => prev + `\n✗ ${res.error ?? 'Install failed'}\n`);
      }
    } catch (err) {
      setInstallLog((prev) => prev + `\n✗ ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      unsubscribe();
      // Clear installing state but keep installLog visible — the log panel
      // renders even when installing is null so the user can read the result.
      setInstalling(null);
    }
  }, [installing, reloadBackends]);

  const openDiagnostics = useCallback(async () => {
    const next = !diagnosticsOpen;
    setDiagnosticsOpen(next);
    if (!next) return;
    setDiagnosticsError(null);
    await reloadBackends();
    const result = await window.vibeMeet.deviceDiagnostics();
    if (result.ok) setDiagnostics(result.diagnostics);
    else setDiagnosticsError(result.error);
  }, [diagnosticsOpen, reloadBackends]);

  // Build the toggle label
  const toggleLabel = currentBackend
    ? `${currentBackend.displayName} ${backendAuthLabel(currentBackend)}`
    : 'Not configured';

  return (
    <div className="join-screen">
      <div className="join-card lobby-card">
        <div className="join-brand">
          <div className="join-logo">
            <img src="icon-96.png" alt="AhaStation" className="join-logo-img" />
          </div>
          <div>
            <div className="join-title">AhaStation</div>
            <div className="join-sub">Pair with AI over screen + voice</div>
          </div>
        </div>

        <div className="join-auth-section">
          <button
            type="button"
            className="join-auth-toggle"
            onClick={() => setAuthOpen((v) => !v)}
          >
            <KeyRound size={14} aria-hidden="true" />
            <span>Host CLI — {toggleLabel}</span>
            <ChevronDown size={14} className={authOpen ? 'join-auth-chevron open' : 'join-auth-chevron'} />
          </button>

          {authOpen && (
            <div className="join-auth-body">
              <p className="join-auth-desc">
                Choose which CLI backend to use as the host. Each backend has its own auth configuration.
              </p>

              {/* Backend selector dropdown */}
              <div className="join-auth-block">
                <div className="join-auth-block-title">
                  Host CLI
                </div>
                <select
                  className="lobby-backend-select"
                  value={selectedBackend}
                  onChange={(e) => { void handleBackendChange(e.target.value); }}
                >
                  {backends.map((b) => (
                    <option key={b.id} value={b.id} disabled={!b.supportsCoordinator}>
                      {b.displayName} {b.loggedIn ? '✓' : ''} {b.isDefault ? '(default)' : ''} {!b.available ? '(not installed)' : ''} {!b.supportsCoordinator ? '(expert only)' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Auth fields for selected backend */}
              {currentBackend?.available ? (
                <>
                  <div className="join-auth-block">
                    <div className="join-auth-block-title">
                      <KeyRound size={13} aria-hidden="true" /> API Key
                      {currentBackend.loggedIn && (
                        <span className="join-auth-badge active">Active</span>
                      )}
                    </div>
                    <div className="join-auth-row">
                      <input
                        type="password"
                        className="join-auth-input"
                        placeholder={currentBackend.hasApiKey ? '••••••••••••••••••••••' : 'Enter API key…'}
                        value={apiKeyInputs[currentBackend.id] ?? ''}
                        onChange={(e) => setApiKeyInputs((prev) => ({ ...prev, [currentBackend.id]: e.target.value }))}
                        onKeyDown={(e) => e.key === 'Enter' && void saveApiKey()}
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="join-auth-btn"
                        onClick={saveApiKey}
                        disabled={apiKeyStatus === 'saving'}
                      >
                        {apiKeyStatus === 'saving' ? 'Saving…'
                          : apiKeyStatus === 'saved' ? 'Saved ✓'
                          : 'Save'}
                      </button>
                    </div>
                    <input
                      type="text"
                      className="join-auth-input join-auth-input-full"
                      placeholder={`Base URL (optional)${currentBackend.baseUrl ? ` — ${currentBackend.baseUrl}` : ''}`}
                      value={baseUrlInput}
                      onChange={(e) => setBaseUrlInput(e.target.value)}
                      onBlur={(e) => {
                        if (e.target.value !== (currentBackend.baseUrl ?? '')) {
                          void saveBaseUrl(e.target.value);
                        }
                      }}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {currentBackend.id !== 'codex' && currentBackend.models && currentBackend.models.length > 0 ? (
                      <select
                        className="join-auth-input join-auth-input-full lobby-backend-select"
                        value={modelInput || ''}
                        onChange={(e) => {
                          setModelInput(e.target.value);
                          void saveModel(e.target.value);
                        }}
                      >
                        <option value="">Default model</option>
                        {currentBackend.models.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <input
                          type="text"
                          className="join-auth-input join-auth-input-full"
                          list={currentBackend.models && currentBackend.models.length > 0
                            ? `${currentBackend.id}-lobby-model-suggestions`
                            : undefined}
                          placeholder={`Model (optional)${currentBackend.defaultModel ? ` — ${currentBackend.defaultModel}` : ''}`}
                          value={modelInput}
                          onChange={(e) => setModelInput(e.target.value)}
                          onBlur={(e) => {
                            if (e.target.value !== (currentBackend.model ?? '')) {
                              void saveModel(e.target.value);
                            }
                          }}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {currentBackend.models && currentBackend.models.length > 0 && (
                          <datalist id={`${currentBackend.id}-lobby-model-suggestions`}>
                            {currentBackend.models.map((m) => (
                              <option key={m} value={m} />
                            ))}
                          </datalist>
                        )}
                      </>
                    )}
                    {apiKeyStatus === 'error' && (
                      <div className="join-auth-error">Failed to save settings.</div>
                    )}
                    <div className="join-auth-hint">
                      Base URL and Model only apply when using an API key. Leave a field blank to clear it.
                    </div>
                  </div>

                  {/* OAuth login section — for backends that support it */}
                  {(currentBackend.id === 'claude-code' ||
                    currentBackend.id === 'kimi' ||
                    currentBackend.id === 'codex' ||
                    currentBackend.id === 'qoder') && (
                    <div className="join-auth-block">
                      <div className="join-auth-block-title">
                        <LogIn size={13} aria-hidden="true" /> {currentBackend.displayName} Account
                        {currentBackend.loggedIn && (
                          <span className="join-auth-badge active">Active</span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="join-auth-btn join-auth-btn-login"
                        onClick={() => {
                          if (currentBackend.id === 'claude-code') {
                            void loginSubscription();
                          } else {
                            void loginOAuth(currentBackend.id);
                          }
                        }}
                        disabled={loginStatus === 'pending'}
                      >
                        {loginStatus === 'pending' ? 'Opening browser…'
                          : loginStatus === 'done' ? 'Logged in ✓'
                          : currentBackend.loggedIn ? 'Re-authenticate'
                          : `Log in with ${currentBackend.displayName}`}
                      </button>
                      {loginStatus === 'error' && (
                        <div className="join-auth-error">{loginError || 'Login failed.'}</div>
                      )}
                      <div className="join-auth-hint">
                        Opens a browser window for OAuth. Requires {currentBackend.displayName} CLI {currentBackend.id === 'claude-code' ? 'bundled with this app' : 'installed'}.
                      </div>
                    </div>
                  )}
                </>
              ) : currentBackend ? (
                <div className="join-auth-block">
                  <div className="join-auth-hint">
                    {currentBackend.installHint ?? `${currentBackend.displayName} is not installed. Install it to use this backend.`}
                  </div>
                  {currentBackend.installHint && currentBackend.installHint !== 'Bundled with AhaStation' && (
                    <button
                      type="button"
                      className="join-auth-btn lobby-install-btn"
                      onClick={() => { void installBackend(currentBackend.id); }}
                      disabled={installing !== null}
                    >
                      <DownloadCloud size={13} aria-hidden="true" />
                      {installing === currentBackend.id ? 'Installing…' : `Install ${currentBackend.displayName}`}
                    </button>
                  )}
                </div>
              ) : null}

              {/* Install log renders outside the conditional above so it stays
                  visible after a successful install, when the backend becomes
                  available and the "not installed" block unmounts. */}
              {installLog && (
                <div className="join-auth-block">
                  <pre className="lobby-install-log">{installLog}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        <section className="lobby-readiness">
          <button
            type="button"
            className="join-auth-toggle"
            onClick={() => { void openDiagnostics(); }}
          >
            <Activity size={14} aria-hidden="true" />
            <span>设备就绪</span>
            <span className="lobby-readiness-summary">
              {backends.filter((backend) => backend.supportsWorkers).length}/4 Worker
            </span>
            <ChevronDown size={14} className={diagnosticsOpen ? 'join-auth-chevron open' : 'join-auth-chevron'} />
          </button>

          {diagnosticsOpen && (
            <div className="device-readiness-panel">
              {diagnostics ? (
                <>
                  <div className="device-readiness-grid">
                    <div>
                      <span>系统</span>
                      <strong>{diagnostics.platform} · {diagnostics.arch}</strong>
                      <small>kernel {diagnostics.kernel} · {diagnostics.sessionType}</small>
                    </div>
                    <div>
                      <span>Electron / GPU</span>
                      <strong>{diagnostics.gpu.available ? '可用' : '诊断失败'}</strong>
                      <small>Electron {diagnostics.electronVersion}</small>
                    </div>
                    <div>
                      <span>音频 / Whisper</span>
                      <strong>{diagnostics.audio.whisper ? 'Whisper 可用' : 'Whisper 需安装'}</strong>
                      <small>
                        麦克风 {microphoneLabel(diagnostics.audio.microphone)}
                        {' · '}
                        扬声器 {diagnostics.audio.speaker === 'available' ? '可用' : '待测试'}
                      </small>
                    </div>
                    <div>
                      <span>Git / 容量</span>
                      <strong>{diagnostics.workspace.worktree ? 'worktree 可用' : '需安装 Git'}</strong>
                      <small>{diagnostics.capacity.hosts} Host · {diagnostics.capacity.workers} Worker</small>
                    </div>
                  </div>

                  <div className="backend-readiness-list">
                    {backends.filter((backend) => ['claude-code', 'opencode', 'codex', 'kimi'].includes(backend.id)).map((backend) => (
                      <div className={`backend-readiness-row is-${backend.workerRuntimeState}`} key={backend.id}>
                        <div>
                          <strong>{backend.displayName}</strong>
                          {backend.workerReleaseTier === 'experimental' && (
                            <span className="backend-readiness-experimental" title="实验性 Worker：未通过首发稳定门禁，可能不稳定">实验</span>
                          )}
                          <span>
                            {backend.workerRuntimeState === 'available'
                              ? '可用'
                              : backend.workerRuntimeState === 'needs-login'
                                ? '需登录'
                                : backend.workerRuntimeState === 'needs-install'
                                  ? '需安装'
                                  : backend.workerRuntimeState === 'version-incompatible'
                                    ? '版本不兼容'
                                    : '诊断失败'}
                          </span>
                        </div>
                        <p>{backend.workerRuntimeReason}</p>
                        <small>
                          {backend.version ?? '版本未知'}
                          {backend.expectedVersion ? ` / 验证版本 ${backend.expectedVersion}` : ''}
                        </small>
                        {backend.workerRuntimeState !== 'available' && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedBackend(backend.id);
                              setAuthOpen(true);
                            }}
                          >
                            {backend.workerRuntimeState === 'needs-install'
                              ? '前往安装'
                              : backend.workerRuntimeState === 'needs-login'
                                ? '前往登录'
                                : '查看处理方式'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="device-readiness-loading" aria-live="polite">
                  {diagnosticsError ?? '正在检查设备、音频、Git 和 Worker 契约…'}
                </div>
              )}
            </div>
          )}
        </section>

        {recoverable.length > 0 && (
          <section className="lobby-section">
            <div className="lobby-section-title">
              <Clock size={13} aria-hidden="true" />
              <span>Interrupted meetings — confirm to resume</span>
            </div>
            <ul className="lobby-list">
              {recoverable.slice(0, 3).map((meeting) => {
                const cwd = typeof meeting.state.cwd === 'string' ? meeting.state.cwd : '';
                const { label, parent } = shortPath(cwd);
                const tasks = Array.isArray(meeting.state.tasks) ? meeting.state.tasks.length : 0;
                const savedTasks = Array.isArray(meeting.state.tasks)
                  ? meeting.state.tasks.filter(
                      (task): task is Record<string, unknown> => Boolean(task && typeof task === 'object'),
                    )
                  : [];
                const autoReadOnly = savedTasks.filter((task) => {
                  const recovery = task.recovery;
                  return Boolean(
                    recovery
                    && typeof recovery === 'object'
                    && (recovery as Record<string, unknown>).autoResume === true,
                  );
                }).length;
                const needsConfirmation = savedTasks.filter((task) => {
                  const recovery = task.recovery;
                  return Boolean(
                    recovery
                    && typeof recovery === 'object'
                    && (recovery as Record<string, unknown>).classification === 'requires-user',
                  );
                }).length;
                return (
                  <li key={meeting.meetingId}>
                    <button
                      type="button"
                      className="lobby-row"
                      onClick={() => { void recoverMeeting(meeting); }}
                      disabled={opening || !cwd}
                      title="Restore durable Meeting state; only explicit read-only tasks may resume automatically"
                    >
                      <span className="lobby-row-icon" aria-hidden="true"><Clock size={16} /></span>
                      <span className="lobby-row-main">
                        <span className="lobby-row-name">Resume {label}</span>
                        <span className="lobby-row-path">
                          {parent} · {tasks} saved tasks
                          {autoReadOnly > 0 ? ` · ${autoReadOnly} read-only auto-resume` : ''}
                          {needsConfirmation > 0 ? ` · ${needsConfirmation} require confirmation` : ''}
                        </span>
                      </span>
                      <span className="lobby-row-meta">Confirm</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {lobby.recent.length > 0 && (
          <section className="lobby-section">
            <div className="lobby-section-title">
              <Clock size={13} aria-hidden="true" />
              <span>Recent meetings</span>
            </div>
            <ul className="lobby-list">
              {lobby.recent.slice(0, 3).map((r) => {
                const { label, parent } = shortPath(r.path);
                return (
                  <li key={r.path}>
                    <button
                      type="button"
                      className="lobby-row"
                      onClick={() => openCwd(r.path)}
                      disabled={opening}
                      title={r.path}
                    >
                      <span className="lobby-row-icon" aria-hidden="true">
                        <FolderOpen size={16} />
                      </span>
                      <span className="lobby-row-main">
                        <span className="lobby-row-name">{label}</span>
                        <span className="lobby-row-path">{parent}</span>
                      </span>
                      <span className="lobby-row-meta">{formatRelative(r.lastOpenedAt)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {(lastError || openError) && (
          <div className="join-error">{openError ?? lastError}</div>
        )}

        <button
          type="button"
          className="join-cta lobby-cta"
          onClick={pickAndOpen}
          disabled={opening}
        >
          <FolderOpen size={16} aria-hidden="true" />
          <span>{opening ? 'Opening…' : 'Open another folder'}</span>
        </button>

        <div className="join-hints">
          <span className="join-hint-item"><Mic size={14} aria-hidden="true" /> Voice on by default</span>
          <span className="join-hint-sep">·</span>
          <span className="join-hint-item"><MonitorUp size={14} aria-hidden="true" /> Manual screen snapshots</span>
          <span className="join-hint-sep">·</span>
          <span className="join-hint-item">⌥ Interrupt anytime</span>
        </div>
      </div>
    </div>
  );
}
