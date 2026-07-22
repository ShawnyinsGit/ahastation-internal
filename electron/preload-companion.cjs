// preload-companion.cjs — minimal preload for the companion screen window.
// Only the companion state channel + sound preference; nothing else.
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
});
