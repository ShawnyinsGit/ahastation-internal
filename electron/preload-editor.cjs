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
    write: (path, content, expectedMtime) =>
      ipcRenderer.invoke('ide-files:write', { path, content, expectedMtime }),
  },
  // PTY terminal (Phase 4): main owns the WebSocket to the opencode server
  // and injects auth; the renderer only sees this narrow API. Downlink data
  // arrives on the same 'ide-editor:event' channel as ideSession events.
  idePty: {
    create: () => ipcRenderer.invoke('ide-pty:create'),
    input: (data) => ipcRenderer.invoke('ide-pty:input', { data }),
    resize: (rows, cols) => ipcRenderer.invoke('ide-pty:resize', { rows, cols }),
    close: () => ipcRenderer.invoke('ide-pty:close'),
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
