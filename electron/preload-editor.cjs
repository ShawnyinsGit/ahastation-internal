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
};

contextBridge.exposeInMainWorld('vibeMeet', api);
