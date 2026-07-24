import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, KeyRound, LogIn, Mic, MonitorUp } from 'lucide-react';
import { usePickCwd } from './DirPickerModal';

interface JoinScreenProps {
  onJoin: (cwd: string) => void;
  defaultCwd?: string;
  lastError?: string | null;
}

type AuthMode = 'apikey' | 'subscription' | null;

export function JoinScreen({ onJoin, defaultCwd, lastError }: JoinScreenProps) {
  const [cwd, setCwd] = useState<string>(defaultCwd ?? '');
  const { pickCwd, pickerModal } = usePickCwd();

  // Auth state
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [subscriptionLoggedIn, setSubscriptionLoggedIn] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [loginStatus, setLoginStatus] = useState<'idle' | 'pending' | 'done' | 'error'>('idle');
  const [loginError, setLoginError] = useState<string>('');
  const apiKeyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (defaultCwd) setCwd(defaultCwd);
  }, [defaultCwd]);

  // Load auth config on mount
  useEffect(() => {
    window.vibeMeet.auth.getConfig().then((cfg) => {
      setAuthMode(cfg.authMode);
      setHasApiKey(cfg.hasApiKey);
    });
    window.vibeMeet.auth.checkSubscriptionStatus().then((s) => {
      setSubscriptionLoggedIn(s.loggedIn);
    });
  }, []);

  const pick = useCallback(async () => {
    const dir = await pickCwd(cwd || undefined);
    if (dir) setCwd(dir);
  }, [pickCwd, cwd]);

  const join = useCallback(async () => {
    let target = cwd;
    if (!target) {
      const dir = await pickCwd();
      if (!dir) return;
      setCwd(dir);
      target = dir;
    }
    onJoin(target);
  }, [cwd, onJoin, pickCwd]);

  const saveApiKey = useCallback(async () => {
    setApiKeyStatus('saving');
    const res = await window.vibeMeet.auth.setApiKey(apiKeyInput);
    if (res.ok) {
      setApiKeyStatus('saved');
      setHasApiKey(apiKeyInput.trim().length > 0);
      setAuthMode(apiKeyInput.trim().length > 0 ? 'apikey' : null);
      setTimeout(() => setApiKeyStatus('idle'), 2000);
    } else {
      setApiKeyStatus('error');
    }
  }, [apiKeyInput]);

  const loginSubscription = useCallback(async () => {
    setLoginStatus('pending');
    setLoginError('');
    const res = await window.vibeMeet.auth.loginSubscription();
    if (res.ok) {
      setLoginStatus('done');
      setAuthMode('subscription');
      setHasApiKey(false);
      // Re-check credential file
      window.vibeMeet.auth.checkSubscriptionStatus().then((s) => {
        setSubscriptionLoggedIn(s.loggedIn);
      });
    } else {
      setLoginStatus('error');
      setLoginError(res.error ?? 'Login failed');
    }
  }, []);

  const authLabel = authMode === 'apikey'
    ? (hasApiKey ? 'API Key ✓' : 'API Key')
    : authMode === 'subscription'
    ? (subscriptionLoggedIn ? 'Claude Account ✓' : 'Claude Account')
    : 'Not configured';

  return (
    <div className="join-screen">
      <div className="join-card">
        <div className="join-brand">
          <div className="join-logo">
            <img src="icon-96.png" alt="AhaStation" className="join-logo-img" />
          </div>
          <div>
            <div className="join-title">AhaStation</div>
            <div className="join-sub">Pair with Claude over screen + voice</div>
          </div>
        </div>

        {/* Claude Auth section */}
        <div className="join-auth-section">
          <button
            type="button"
            className="join-auth-toggle"
            onClick={() => setAuthOpen((v) => !v)}
          >
            <KeyRound size={14} aria-hidden="true" />
            <span>Claude authentication — {authLabel}</span>
            <ChevronDown size={14} className={authOpen ? 'join-auth-chevron open' : 'join-auth-chevron'} />
          </button>

          {authOpen && (
            <div className="join-auth-body">
              <p className="join-auth-desc">
                Choose how AhaStation connects to Claude. Use an API key for programmatic access,
                or log in with your Claude.ai subscription account.
              </p>

              {/* API Key */}
              <div className="join-auth-block">
                <div className="join-auth-block-title">
                  <KeyRound size={13} aria-hidden="true" /> API Key
                  {authMode === 'apikey' && hasApiKey && <span className="join-auth-badge active">Active</span>}
                </div>
                <div className="join-auth-row">
                  <input
                    ref={apiKeyRef}
                    type="password"
                    className="join-auth-input"
                    placeholder={hasApiKey ? '••••••••••••••••••••••' : 'sk-ant-...'}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveApiKey()}
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
                {apiKeyStatus === 'error' && (
                  <div className="join-auth-error">Failed to save key.</div>
                )}
                {hasApiKey && authMode === 'apikey' && (
                  <div className="join-auth-hint">
                    Leave blank and save to remove the stored key.
                  </div>
                )}
              </div>

              {/* Subscription login */}
              <div className="join-auth-block">
                <div className="join-auth-block-title">
                  <LogIn size={13} aria-hidden="true" /> Claude Account (Pro/Max)
                  {authMode === 'subscription' && subscriptionLoggedIn && (
                    <span className="join-auth-badge active">Active</span>
                  )}
                </div>
                <button
                  type="button"
                  className="join-auth-btn join-auth-btn-login"
                  onClick={loginSubscription}
                  disabled={loginStatus === 'pending'}
                >
                  {loginStatus === 'pending' ? 'Opening browser…'
                    : loginStatus === 'done' ? 'Logged in ✓'
                    : subscriptionLoggedIn ? 'Re-authenticate'
                    : 'Log in with Claude'}
                </button>
                {loginStatus === 'error' && (
                  <div className="join-auth-error">{loginError || 'Login failed.'}</div>
                )}
                <div className="join-auth-hint">
                  Opens a browser window for OAuth. Requires Claude CLI bundled with this app.
                </div>
              </div>
            </div>
          )}
        </div>

        <label className="join-field">
          <span className="join-field-label">Working directory</span>
          <button type="button" className="join-cwd" onClick={pick}>
            <span className="join-cwd-icon" aria-hidden="true"><FolderOpen size={18} /></span>
            <span className="join-cwd-text">{cwd || 'Choose the folder Claude should work in'}</span>
            <span className="join-cwd-edit">Change</span>
          </button>
        </label>

        {lastError && <div className="join-error">{lastError}</div>}

        <button className="join-cta" onClick={join}>
          Start meeting
        </button>

        <div className="join-hints">
          <span className="join-hint-item"><Mic size={14} aria-hidden="true" /> Voice on by default</span>
          <span className="join-hint-sep">·</span>
          <span className="join-hint-item"><MonitorUp size={14} aria-hidden="true" /> Manual screen snapshots</span>
          <span className="join-hint-sep">·</span>
          <span className="join-hint-item">⌥ Interrupt anytime</span>
        </div>
      </div>
      {pickerModal}
    </div>
  );
}
