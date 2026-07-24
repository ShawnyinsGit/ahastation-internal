import { startDevFixtureIfPresent } from './dev-fixture-bootstrap';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsWindow } from './components/SettingsWindow';
import { PopoutPlaceholder } from './components/PopoutPlaceholder';
import { OpenCodeEditor } from './components/OpenCodeEditor';
import { CompanionScreen } from './components/CompanionScreen';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { parseEditorCapabilities } from './types';
import { meetingStore } from './lib/meeting-store';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const viewParam = params.get('view');
const isSettingsView = viewParam === 'settings';
const isPopoutView = viewParam === 'popout';
const isOpenCodeEditorView = viewParam === 'opencode-editor';
const isCompanionView = viewParam === 'companion';

if (isCompanionView) {
  document.documentElement.classList.add('companion-view');
  document.title = '陪伴屏';
}

if (isSettingsView) {
  document.documentElement.classList.add('settings-view');
  document.title = '设置';
}

if (isPopoutView) {
  document.documentElement.classList.add('popout-view');
  const type = params.get('type') ?? 'window';
  document.title = `独立窗口 — ${type}`;
}

if (isOpenCodeEditorView) {
  const hostId = params.get('hostId') ?? 'unknown';
  document.title = `OpenCode — ${hostId}`;
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <AppErrorBoundary>
    {isSettingsView
      ? <SettingsWindow />
      : isPopoutView
        ? <PopoutPlaceholder />
        : isCompanionView
          ? <CompanionScreen />
          : isOpenCodeEditorView
            ? <OpenCodeEditor
                hostId={params.get('hostId') ?? ''}
                backendId={params.get('backendId') ?? ''}
                sessionId={params.get('sessionId') ?? ''}
                cwd={params.get('cwd') ?? ''}
                capabilities={parseEditorCapabilities(params.get('caps'))}
              />
            : <App />}
  </AppErrorBoundary>,
);

if (import.meta.env.DEV) {
  const fixture = params.get('ui-fixture');
  if (fixture && fixture !== 'lobby') {
    window.setTimeout(() => {
      void meetingStore.openSession('/workspace/ahastation-demo').then(() => {
        window.setTimeout(startDevFixtureIfPresent, 100);
      });
    }, 100);
  } else {
    window.setTimeout(startDevFixtureIfPresent, 100);
  }
}
