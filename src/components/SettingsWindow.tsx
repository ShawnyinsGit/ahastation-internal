// SettingsWindow — standalone settings page loaded in its own BrowserWindow
// via ?view=settings. Opaque solid background, no glass/transparency.
// Hosts all settings panels: Memory, Voice, VoiceLock, Skills.

import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { useVoicePreferences } from '../hooks/useVoicePreferences';
import { useVoiceLock } from '../hooks/useVoiceLock';
import { MemoryPanel } from './MemoryPanel';
import { VoiceSelector } from './VoiceSelector';
import { VoiceLockPanel } from './VoiceLockPanel';
import { SkillManagerPanel } from './SkillManagerPanel';
import { BackendSettings } from './BackendSettings';
import { IDEManagerPanel } from './IDEManagerPanel';
import { VoiceGuideModal } from './VoiceGuideModal';
import { SPEAKER_MODEL_ID } from '../lib/speaker-embedding';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class SettingsErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[SettingsWindow] Uncaught error:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="settings-window">
          <header className="settings-window-header">
            <h1 className="settings-window-title">设置</h1>
          </header>
          <div className="settings-window-body" style={{ padding: 24, textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>设置加载失败</h2>
            <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
              {this.state.error.message || 'An unexpected error occurred'}
            </p>
            <button
              type="button"
              className="settings-window-close"
              style={{ position: 'static', padding: '8px 20px', fontSize: 13 }}
              onClick={() => window.close()}
            >
              关闭窗口
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Dummy refs/callbacks for useVoiceLock — the settings window has no active
// audio session, so mute/speaking state is irrelevant. The hook still needs
// these arguments for type correctness and to update its own enrollment state.
const noopSetState = () => {};
const dummySpeakingRef = { current: false };

function SettingsWindowInner() {
  const voicePrefs = useVoicePreferences();
  const [appVersion, setAppVersion] = useState<string>('');
  const [updateInfo, setUpdateInfo] = useState<{ latest: string; url: string } | null>(null);
  const voiceLock = useVoiceLock({
    muted: false,
    setMuted: noopSetState,
    setAiSpeaking: noopSetState,
    speakingRef: dummySpeakingRef,
  });

  useEffect(() => {
    void window.vibeMeet.appVersion().then(setAppVersion).catch(() => {});
    return window.vibeMeet.onUpdateAvailable((info) => setUpdateInfo(info));
  }, []);

  const handleClose = useCallback(() => {
    void window.vibeMeet.settingsWindow.close();
  }, []);

  return (
    <div className="settings-window">
      <header className="settings-window-header">
        <h1 className="settings-window-title">设置</h1>
        <button
          type="button"
          className="settings-window-close"
          onClick={handleClose}
          aria-label="关闭设置"
        >
          ✕
        </button>
      </header>
      <div className="settings-window-version">
        当前版本 v{appVersion || '…'}
        {updateInfo && (
          <>
            {' · '}
            <a href={updateInfo.url} target="_blank" rel="noreferrer">
              新版本 {updateInfo.latest} 可用，前往下载
            </a>
          </>
        )}
      </div>
      <div className="settings-window-body">
        <BackendSettings />
        <IDEManagerPanel />
        <MemoryPanel />
        <VoiceSelector
          voices={voicePrefs.voices}
          selectedVoiceName={voicePrefs.selectedVoiceName}
          onChange={voicePrefs.handleVoiceChange}
          onOpenGuide={voicePrefs.handleOpenGuide}
          filterMode={voicePrefs.filterMode}
          onChangeFilterMode={voicePrefs.handleFilterModeChange}
          voicePolishEnabled={voicePrefs.voicePolishEnabled}
          onChangeVoicePolish={voicePrefs.handleVoicePolishChange}
          reportModeEnabled={voicePrefs.reportModeEnabled}
          onChangeReportMode={voicePrefs.handleReportModeChange}
          handheldMode={voicePrefs.handheldMode}
          onChangeHandheldMode={voicePrefs.handleHandheldModeChange}
          asrProvider={voicePrefs.asrProvider}
          onChangeAsrProvider={voicePrefs.handleAsrProviderChange}
          cloudAsr={voicePrefs.cloudAsr}
          onCloudAsrInput={voicePrefs.handleCloudAsrInput}
          onCloudAsrCommit={voicePrefs.handleCloudAsrCommit}
        />
        <VoiceLockPanel
          enabled={voiceLock.voiceLockEnabled}
          enrolledAt={voiceLock.voicePrint?.enrolledAt ?? null}
          modelMatches={voiceLock.voicePrint?.model === SPEAKER_MODEL_ID}
          enrollment={voiceLock.enrollment}
          recentlyRejected={voiceLock.recentlyRejected}
          enrollmentToast={voiceLock.enrollmentToast}
          onToggleEnabled={voiceLock.handleToggleVoiceLock}
          onStartEnroll={voiceLock.handleStartEnrollment}
          onCancelEnroll={voiceLock.handleCancelEnrollment}
          onClearEnrollment={voiceLock.handleClearEnrollment}
        />
        <SkillManagerPanel />
      </div>
      {voicePrefs.guideOpen && (
        <VoiceGuideModal
          open={voicePrefs.guideOpen}
          onClose={voicePrefs.handleGuideClose}
          onDismissForever={voicePrefs.handleDismissForever}
        />
      )}
    </div>
  );
}

export function SettingsWindow() {
  return (
    <SettingsErrorBoundary>
      <SettingsWindowInner />
    </SettingsErrorBoundary>
  );
}
