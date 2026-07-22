// preload-editor.cjs — minimal preload for OpenCode editor windows.
//
// The editor is a read-only file browser; it must NOT receive the full
// meeting control surface exposed by preload.cjs (~70 entries including
// sessions.close, setApiKey, permission resolution, browser control, ...).
// Confirmed against src/components/OpenCodeEditor.tsx + src/main.tsx: the
// only bridge API the editor view uses is ideFiles.list/read. window.close()
// is a native DOM capability and needs no preload bridge.
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // Secure editor file browsing. No cwd is ever sent — the main process
  // resolves the workspace from the sender's editor-window registration.
  ideFiles: {
    list: (path) => ipcRenderer.invoke('ide-files:list', { path }),
    read: (path) => ipcRenderer.invoke('ide-files:read', { path }),
  },
  // Live panel state (Phase 2 PR③): initial snapshot pull + point-to-point
  // incremental events for THIS window's hostId (status / todo / diff /
  // activity). Main never broadcasts; each window only receives its own.
  ideSession: {
    getState: () => ipcRenderer.invoke('ide-editor:get-state'),
    onEvent: (cb) => {
      const listener = (_, msg) => cb(msg);
      ipcRenderer.on('ide-editor:event', listener);
      return () => ipcRenderer.removeListener('ide-editor:event', listener);
    },
  },
};

contextBridge.exposeInMainWorld('vibeMeet', api);
