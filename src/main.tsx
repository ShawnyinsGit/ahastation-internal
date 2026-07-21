import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsWindow } from './components/SettingsWindow';
import { PopoutPlaceholder } from './components/PopoutPlaceholder';
import { OpenCodeEditor } from './components/OpenCodeEditor';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const viewParam = params.get('view');
const isSettingsView = viewParam === 'settings';
const isPopoutView = viewParam === 'popout';
const isOpenCodeEditorView = viewParam === 'opencode-editor';

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
        : isOpenCodeEditorView
          ? <OpenCodeEditor
              hostId={params.get('hostId') ?? ''}
              backendId={params.get('backendId') ?? ''}
              sessionId={params.get('sessionId') ?? ''}
              cwd={params.get('cwd') ?? ''}
            />
          : <App />}
  </AppErrorBoundary>,
);
