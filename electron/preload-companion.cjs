// preload-companion.cjs — minimal preload for the floating companion / AhaBar
// window. Companion state + sound prefs + AhaBar resolve/focus controls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vibeMeet', {
  companion: {
    getState: () => ipcRenderer.invoke('companion:get-state'),
    onEvent: (cb) => {
      const listener = (_, state) => cb(state);
      ipcRenderer.on('companion:event', listener);
      return () => ipcRenderer.removeListener('companion:event', listener);
    },
    getPrefs: () => ipcRenderer.invoke('companion:get-prefs'),
    setSound: (soundEnabled) => ipcRenderer.invoke('companion:set-sound', { soundEnabled }),
  },
  ahabar: {
    getState: () => ipcRenderer.invoke('ahabar:get-state'),
    onEvent: (cb) => {
      const listener = (_, state) => cb(state);
      ipcRenderer.on('ahabar:event', listener);
      return () => ipcRenderer.removeListener('ahabar:event', listener);
    },
    resolvePermission: (id, decision) =>
      ipcRenderer.invoke('ahabar:resolve-permission', { id, decision }),
    focusMain: () => ipcRenderer.invoke('ahabar:focus-main'),
    setExpanded: (expanded) => ipcRenderer.invoke('ahabar:set-expanded', { expanded }),
    setGhost: (ghost) => ipcRenderer.invoke('ahabar:set-ghost', { ghost }),
  },
});
