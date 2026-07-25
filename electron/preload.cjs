const { contextBridge, ipcRenderer } = require('electron');

// Most send* methods take an explicit sessionId so the renderer can target a
// specific tab's Orchestrator. Passing `null` (or omitting it) lets main fall
// back to the currently-active slot — used by legacy callsites that haven't
// been threaded for tabs yet.
const api = {
  sessions: {
    open: (cwd, greeting, backendId, recoveryMeetingId) =>
      ipcRenderer.invoke('sessions:open', { cwd, greeting, backendId, recoveryMeetingId }),
    close: (id) => ipcRenderer.invoke('sessions:close', { id }),
    setActive: (id) => ipcRenderer.invoke('sessions:set-active', { id }),
    list: () => ipcRenderer.invoke('sessions:list'),
    listRestore: () => ipcRenderer.invoke('sessions:list-restore'),
    listRecoverable: () => ipcRenderer.invoke('sessions:list-recoverable'),
    resolveRecoveredTask: (sessionId, taskId, action) =>
      ipcRenderer.invoke('sessions:resolve-recovered-task', { sessionId, taskId, action }),
    addHost: (sessionId, backendId, hostId) =>
      ipcRenderer.invoke('sessions:add-host', { sessionId, backendId, hostId }),
    removeHost: (sessionId, hostId) =>
      ipcRenderer.invoke('sessions:remove-host', { sessionId, hostId }),
    listHosts: (sessionId) =>
      ipcRenderer.invoke('sessions:list-hosts', { sessionId }),
    setCoordinator: (sessionId, hostId) =>
      ipcRenderer.invoke('sessions:set-coordinator', { sessionId, hostId }),
    restartHost: (sessionId, hostId) =>
      ipcRenderer.invoke('sessions:restart-host', { sessionId, hostId }),
  },
  sendUserText: (sessionId, text) =>
    ipcRenderer.invoke('session:user-text', { sessionId, text }),
  sendUserImage: (sessionId, dataUrl, caption) =>
    ipcRenderer.invoke('session:user-image', { sessionId, dataUrl, caption }),
  sendUserAttachments: (sessionId, items, caption) =>
    ipcRenderer.invoke('session:user-attachments', { sessionId, items, caption }),
  resolvePermission: (sessionId, id, decision, message, scope) =>
    ipcRenderer.invoke('session:resolve-permission', { sessionId, id, decision, message, scope }),
  interrupt: (sessionId) => ipcRenderer.invoke('session:interrupt', { sessionId }),
  setPermissionMode: (sessionId, mode) =>
    ipcRenderer.invoke('session:set-permission-mode', { sessionId, mode }),
  setAutoApprove: (scope) => ipcRenderer.invoke('session:set-auto-approve', { scope }),
  setOrchestrationMode: (sessionId, enabled) => ipcRenderer.invoke('session:set-orchestration-mode', { sessionId, enabled }),
  approvePlan: (sessionId, approved, tasks) =>
    ipcRenderer.invoke('session:approve-plan', { sessionId, approved, ...(tasks ? { tasks } : {}) }),
  acceptDelivery: (sessionId, deliveryId, candidateId) =>
    ipcRenderer.invoke('session:accept-delivery', { sessionId, deliveryId, candidateId }),
  returnDelivery: (sessionId, deliveryId, candidateId, feedback) =>
    ipcRenderer.invoke('session:return-delivery', {
      sessionId,
      deliveryId,
      candidateId,
      feedback,
    }),
  meetingDelivery: {
    get: (sessionId) =>
      ipcRenderer.invoke('meeting-delivery:get', { sessionId }),
    accept: (sessionId, deliveryId, contentHash) =>
      ipcRenderer.invoke('meeting-delivery:accept', { sessionId, deliveryId, contentHash }),
    requestRework: (sessionId, deliveryId, contentHash, reason) =>
      ipcRenderer.invoke('meeting-delivery:request-rework', {
        sessionId,
        deliveryId,
        contentHash,
        reason,
      }),
  },
  endSession: (sessionId) => ipcRenderer.invoke('session:end', { sessionId }),
  pickCwd: () => ipcRenderer.invoke('dialog:pick-cwd'),
  listDir: (path, showHidden) => ipcRenderer.invoke('dialog:list-dir', { path, showHidden }),
  confirmCwd: (path) => ipcRenderer.invoke('dialog:confirm-cwd', { path }),
  getVoiceConfig: () => ipcRenderer.invoke('settings:get-voice-config'),
  setVoiceLockEnabled: (on) => ipcRenderer.invoke('settings:set-voice-lock-enabled', on),
  setVoicePrint: (vp) => ipcRenderer.invoke('settings:set-voice-print', vp),
  getVoicePref: () => ipcRenderer.invoke('settings:get-voice-pref'),
  setVoicePref: (patch) => ipcRenderer.invoke('settings:set-voice-pref', patch),
  openVoiceSettings: () => ipcRenderer.invoke('system:open-voice-settings'),
  useSystemPicker: () => ipcRenderer.invoke('desktop:use-system-picker'),
  getDesktopSources: () => ipcRenderer.invoke('desktop:get-sources'),
  checkScreenPermission: () => ipcRenderer.invoke('desktop:check-permission'),
  openScreenSettings: () => ipcRenderer.invoke('desktop:open-settings'),
  requestMicPermission: () => ipcRenderer.invoke('mic:request-permission'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  asrAvailable: () => ipcRenderer.invoke('asr:available'),
  deviceDiagnostics: () => ipcRenderer.invoke('device:diagnostics'),
  startAsrStream: (lang, includePreRoll) =>
    ipcRenderer.invoke('asr:stream-start', { lang, includePreRoll }),
  sendAsrStreamFrame: (pcmBuffer, live) =>
    ipcRenderer.send('asr:stream-frame', pcmBuffer, live),
  finishAsrStream: (sessionId) => ipcRenderer.invoke('asr:stream-finish', sessionId),
  cancelAsrStream: (sessionId) => ipcRenderer.invoke('asr:stream-cancel', sessionId),
  polishAsrText: (text) => ipcRenderer.invoke('asr:polish-text', text),
  auth: {
    getConfig: () => ipcRenderer.invoke('auth:get-config'),
    setApiKey: (key) => ipcRenderer.invoke('auth:set-api-key', key),
    setBaseUrl: (url) => ipcRenderer.invoke('auth:set-base-url', url),
    setModel: (model) => ipcRenderer.invoke('auth:set-model', model),
    setMode: (mode) => ipcRenderer.invoke('auth:set-mode', mode),
    loginSubscription: () => ipcRenderer.invoke('auth:login-subscription'),
    checkSubscriptionStatus: () => ipcRenderer.invoke('auth:check-subscription-status'),
  },
  backendAuth: {
    list: () => ipcRenderer.invoke('backend-auth:list'),
    getConfig: (backendId) => ipcRenderer.invoke('backend-auth:get-config', backendId),
    setApiKey: (backendId, key) => ipcRenderer.invoke('backend-auth:set-api-key', { backendId, key }),
    setBaseUrl: (backendId, url) => ipcRenderer.invoke('backend-auth:set-base-url', { backendId, url }),
    setModel: (backendId, model) => ipcRenderer.invoke('backend-auth:set-model', { backendId, model }),
    setMode: (backendId, mode) => ipcRenderer.invoke('backend-auth:set-mode', { backendId, mode }),
    setAvatar: (backendId, dataUrl) => ipcRenderer.invoke('backend-auth:set-avatar', { backendId, dataUrl }),
    setDefault: (backendId) => ipcRenderer.invoke('backend-auth:set-default', backendId),
    checkStatus: (backendId) => ipcRenderer.invoke('backend-auth:check-status', backendId),
    loginOAuth: (backendId) => ipcRenderer.invoke('backend-auth:login-oauth', backendId),
    install: (backendId) => ipcRenderer.invoke('backend-auth:install', backendId),
    onInstallProgress: (cb) => {
      const listener = (_, data) => cb(data);
      ipcRenderer.on('backend:install-progress', listener);
      return () => ipcRenderer.removeListener('backend:install-progress', listener);
    },
  },
  customBackend: {
    list: () => ipcRenderer.invoke('custom-backend:list'),
    add: (payload) => ipcRenderer.invoke('custom-backend:add', payload),
    update: (payload) => ipcRenderer.invoke('custom-backend:update', payload),
    remove: (id) => ipcRenderer.invoke('custom-backend:remove', id),
  },
  memory: {
    list: (filter) => ipcRenderer.invoke('memory:list', filter ?? null),
    update: (id, patch) => ipcRenderer.invoke('memory:update', { id, patch }),
    delete: (id) => ipcRenderer.invoke('memory:delete', id),
    currentProjectId: (sessionId) => ipcRenderer.invoke('memory:projectId', { sessionId }),
  },
  decisions: {
    open: (path) => ipcRenderer.invoke('decision:open', path),
  },
  documents: {
    read: (sessionId, path) => ipcRenderer.invoke('documents:read', { sessionId, path }),
    list: (sessionId, dirPath) => ipcRenderer.invoke('documents:list', { sessionId, dirPath }),
    openExternal: (sessionId, path) => ipcRenderer.invoke('documents:open-external', { sessionId, path }),
  },
  tasks: {
    getSnapshot: (sessionId, taskId) =>
      ipcRenderer.invoke('tasks:get-snapshot', { sessionId, taskId }),
    getEvents: (sessionId, taskId, afterSeq, limit) =>
      ipcRenderer.invoke('tasks:get-events', { sessionId, taskId, afterSeq, limit }),
    onEvent: (sessionId, taskId, afterSeq, cb) => {
      const subscriptionId = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const listener = (_event, payload) => {
        if (payload?.subscriptionId !== subscriptionId || !payload.event) return;
        cb(payload.event);
      };
      ipcRenderer.on('tasks:event', listener);
      const subscribePromise = ipcRenderer.invoke('tasks:subscribe', {
        sessionId,
        taskId,
        afterSeq,
        subscriptionId,
      }).then((result) => {
        if (!result?.ok) console.warn('[tasks] subscription failed:', result?.error);
      }).catch((error) => {
        console.warn('[tasks] subscription failed:', String(error));
      });
      let disposed = false;
      return () => {
        if (disposed) return;
        disposed = true;
        ipcRenderer.removeListener('tasks:event', listener);
        // Ordering matters: an immediate close can race the async main-process
        // subscribe handler. Send the cancellation only after that handler
        // settles so a late subscription cannot leak.
        void subscribePromise.finally(() => {
          ipcRenderer.send('tasks:unsubscribe', { subscriptionId });
        });
      };
    },
    followUp: (sessionId, taskId, text) =>
      ipcRenderer.invoke('tasks:follow-up', { sessionId, taskId, text }),
    steer: (sessionId, taskId, text) =>
      ipcRenderer.invoke('tasks:steer', { sessionId, taskId, text }),
    interrupt: (sessionId, taskId, reason) =>
      ipcRenderer.invoke('tasks:interrupt', { sessionId, taskId, reason }),
    extendBudget: (sessionId, taskId, expectedPlanVersion, budget) =>
      ipcRenderer.invoke('tasks:extend-budget', {
        sessionId,
        taskId,
        expectedPlanVersion,
        budget,
      }),
    confirmReviewEvidence: (sessionId, taskId, reviewId, chunkId, chunkHash) =>
      ipcRenderer.invoke('tasks:confirm-review-evidence', {
        sessionId,
        taskId,
        reviewId,
        chunkId,
        chunkHash,
      }),
    resumeReview: (sessionId, taskId, reviewId) =>
      ipcRenderer.invoke('tasks:resume-review', { sessionId, taskId, reviewId }),
  },
  transcripts: {
    load: (cwd) => ipcRenderer.invoke('transcripts:load', { cwd }),
    // Fire-and-forget: the renderer's caller already ignores the result
    // (.catch swallows errors), so we skip the round-trip ack. Saves an
    // extra IPC reply per transcript line — at 5–10 lines/sec during a busy
    // meeting that's 10–30 ms/sec of main-thread time freed up. We still
    // return a resolved Promise to preserve the existing type shape.
    append: (cwd, entry) => {
      ipcRenderer.send('transcripts:append', { cwd, entry });
      return Promise.resolve({ ok: true });
    },
    clear: (cwd) => ipcRenderer.invoke('transcripts:clear', { cwd }),
  },
  accessibility: {
    check: () => ipcRenderer.invoke('accessibility:check'),
    request: () => ipcRenderer.invoke('accessibility:request'),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    install: (source) => ipcRenderer.invoke('skills:install', source),
    uninstall: (name) => ipcRenderer.invoke('skills:uninstall', name),
  },
  settingsWindow: {
    open: () => ipcRenderer.invoke('settings:open-window'),
    close: () => ipcRenderer.invoke('settings:close-window'),
  },
  openCodeEditor: {
    open: (payload) => ipcRenderer.invoke('opencode-editor:open', payload),
    close: (hostId) => ipcRenderer.invoke('opencode-editor:close', { hostId }),
    list: () => ipcRenderer.invoke('opencode-editor:list'),
  },
  ideRegistry: {
    list: () => ipcRenderer.invoke('ide-registry:list'),
    setDefault: (id) => ipcRenderer.invoke('ide-registry:set-default', { id }),
    setOverride: (hostId, ideId) => ipcRenderer.invoke('ide-registry:set-override', { hostId, ideId }),
  },
  // Editor-surface APIs. In the main window these are used ONLY by the
  // handheld editor overlay (Phase 6a) — every channel re-validates the
  // sender against the overlay binding / window registry, so exposing them
  // here grants nothing until the overlay is bound.
  ideFiles: {
    list: (path) => ipcRenderer.invoke('ide-files:list', { path }),
    read: (path) => ipcRenderer.invoke('ide-files:read', { path }),
    write: (path, content, expectedMtime) =>
      ipcRenderer.invoke('ide-files:write', { path, content, expectedMtime }),
  },
  ideSession: {
    getState: () => ipcRenderer.invoke('ide-editor:get-state'),
    onEvent: (cb) => {
      const listener = (_, msg) => cb(msg);
      ipcRenderer.on('ide-editor:event', listener);
      return () => ipcRenderer.removeListener('ide-editor:event', listener);
    },
  },
  idePty: {
    create: () => ipcRenderer.invoke('ide-pty:create'),
    input: (data) => ipcRenderer.invoke('ide-pty:input', { data }),
    resize: (rows, cols) => ipcRenderer.invoke('ide-pty:resize', { rows, cols }),
    close: () => ipcRenderer.invoke('ide-pty:close'),
  },
  ideOverlay: {
    bind: (hostId, sessionId) => ipcRenderer.invoke('ide-editor:overlay-bind', { active: true, hostId, sessionId }),
    close: () => ipcRenderer.invoke('ide-editor:overlay-bind', { active: false }),
    reportScene: (scene) => ipcRenderer.invoke('ide-editor:report-scene', { scene }),
    getScene: (hostId) => ipcRenderer.invoke('ide-editor:get-scene', { hostId }),
  },
  onDisplayChanged: (cb) => {
    const listener = (_, info) => cb(info);
    ipcRenderer.on('display-changed', listener);
    return () => ipcRenderer.removeListener('display-changed', listener);
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  onUpdateAvailable: (cb) => {
    const listener = (_, info) => cb(info);
    ipcRenderer.on('update-available', listener);
    return () => ipcRenderer.removeListener('update-available', listener);
  },
  companion: {
    // Main-window side: toggle the floating companion window + relay the
    // TTS-active flag (sound ducking). The companion window itself uses the
    // narrow preload-companion.cjs bridge instead.
    // Phase 1 defaults to AhaBar; pass { view: 'companion' } for the Phaser office.
    toggle: (opts) => ipcRenderer.invoke('companion:toggle', opts ?? {}),
    ttsState: (active) => ipcRenderer.send('companion:tts-state', { active }),
  },
  popoutSession: (tabId) => ipcRenderer.invoke('popout:open-session', { tabId }),
  popoutStage: (windowId, type) => ipcRenderer.invoke('popout:open-stage', { windowId, type }),
  browser: {
    openTab: (url) => ipcRenderer.invoke('browser:open-tab', { url }),
    closeTab: (tabId) => ipcRenderer.invoke('browser:close-tab', { tabId }),
    setActive: (tabId) => ipcRenderer.invoke('browser:set-active', { tabId }),
    navigate: (tabId, url) => ipcRenderer.invoke('browser:navigate', { tabId, url }),
    back: (tabId) => ipcRenderer.invoke('browser:back', { tabId }),
    forward: (tabId) => ipcRenderer.invoke('browser:forward', { tabId }),
    reload: (tabId) => ipcRenderer.invoke('browser:reload', { tabId }),
    setBounds: (bounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
    setVisible: (visible) => ipcRenderer.invoke('browser:set-visible', { visible }),
    getState: () => ipcRenderer.invoke('browser:get-state'),
    capturePage: (tabId) => ipcRenderer.invoke('browser:capture-page', { tabId }),
    onStateUpdate: (cb) => {
      const listener = (_, state) => cb(state);
      ipcRenderer.on('browser:state-update', listener);
      return () => ipcRenderer.removeListener('browser:state-update', listener);
    },
  },
  steerWorker: (sessionId, workerId, addendum) =>
    ipcRenderer.invoke('session:steer-worker', { sessionId, workerId, addendum }),
  interruptWorker: (sessionId, workerId) =>
    ipcRenderer.invoke('session:interrupt-worker', { sessionId, workerId }),
  onEvent: (cb) => {
    const listener = (_, e) => cb(e);
    ipcRenderer.on('session:event', listener);
    return () => ipcRenderer.removeListener('session:event', listener);
  },
};

contextBridge.exposeInMainWorld('vibeMeet', api);
