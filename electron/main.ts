import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme, net, protocol, screen as electronScreen } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { AutoApproveScope } from './auto-approve-policy.js';
import { SessionRegistry } from './sessions.js';
import { flushSettingsWrites, getSettings, updateSettings } from './store.js';
import { registerCustomBackends } from './backends/registry.js';
import type { IpcContext, IpcEmittedEvent } from './ipc/context.js';
import { handleSecure, mainWindowSenderPolicy } from './ipc/validators.js';
import { BrowserTabManager } from './browser-tab-manager.js';
import { requestMicrophoneAccess } from './microphone-access.js';
import { checkForUpdateCached } from './update-check.js';
import { getCompanionFeed } from './companion/companion-feed.js';
import { isCompanionWindowOpen, toggleCompanionWindow } from './companion/companion-window-manager.js';
import {
  resolveMinimizeOutcome,
  shouldPromptMinimize,
  type MinimizePromptKind,
} from './minimize-prompt.js';
import { ObserveService } from './observe/observe-service.js';
import { captureProcessSnapshot, descendantsOf } from './observe/process/darwin.js';
import type { ObservedSnapshot } from './observe/types.js';
import {
  buildRendererSecurityHeaders,
  resolveAppAssetPath,
  themeBackgroundColor,
} from './renderer-security.js';

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
    codeCache: true,
  },
}]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;
// Multi-tab session store. Each slot owns one Orchestrator (= one Talker +
// scheduler) tied to a single cwd. Replaces the prior global `orchestrator`
// + `currentCwd` + `recapPending` triple — those now live per-slot inside
// the registry. `recapPending` for a slot is tracked on the slot itself.
const registry = new SessionRegistry();
// Embedded browser tab manager. Owns all WebContentsView instances for the
// built-in browser panel. Wired into main window after createWindow().
const browserTabManager = new BrowserTabManager();
// Trust-mode scope — module-level so it survives between session start/stop
// and isn't lost when the renderer reloads. Default OFF every launch; we
// intentionally do NOT persist this to disk. Shared across all slots: see
// the note in IpcContext for the rationale (avoid backgrounded-tab privilege
// confusion).
let autoApprove: AutoApproveScope = 'off';
// Shadow HOME pointing at the merged bundled+user .claude tree, computed
// once at app launch. `null` in dev mode → SDK uses real ~/.claude.
//
// We kick the build off the launch critical path: createWindow() runs
// immediately, the shadow tree resolves in the background, and sessions:open
// awaits this promise the first time it actually needs HOME (typically
// 1–3 s after launch when the user clicks "Open"). Callers should use
// `awaitClaudeShadowHome` rather than peek at `claudeShadowHome` directly.
let claudeShadowHome: string | null = null;
let claudeShadowHomeReady: Promise<string | null> = Promise.resolve(null);
function awaitClaudeShadowHome(): Promise<string | null> {
  return claudeShadowHomeReady;
}

const isDev = !app.isPackaged && !!process.env.VITE_DEV_SERVER_URL;

function registerAppProtocol(): void {
  const bundleRoot = join(__dirname, '..', 'dist');
  protocol.handle('app', (request) => {
    const path = resolveAppAssetPath(bundleRoot, request.url);
    if (!path) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
}

// B11/B12: a single live-window accessor. Every caller outside createWindow
// goes through this so the "is it still there?" check is impossible to forget.
// Anything inside createWindow is fine to touch mainWindow directly — TS
// narrows the freshly-assigned value within the function scope.
function liveWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  return mainWindow;
}

function getThemeBackgroundColor(): string {
  return themeBackgroundColor(nativeTheme.shouldUseDarkColors);
}

// ---- Minimize/close → AhaBar prompt -----------------------------------------
// Intercepting minimize/close to offer AhaBar. While a prompt is on screen the
// original window action is held (preventDefault); the renderer's answer
// arrives on app:minimize-choice. A 60s fail-safe replays the original action
// if the renderer never answers (crash, hang, breakpoint). The suppress flags
// make our own replayed minimize()/close() skip the interception exactly once.

const MINIMIZE_PROMPT_FAILSAFE_MS = 60_000;

let minimizePromptPending: { kind: MinimizePromptKind; failsafe: NodeJS.Timeout } | null = null;
let suppressNextMinimize = false;
let suppressNextClose = false;

function minimizePromptGateOpen(): boolean {
  return shouldPromptMinimize({
    ahaBarOpen: isCompanionWindowOpen('ahabar'),
    promptDisabled: getSettings().ahaBarPromptDisabled === true,
    quitting: isQuitting,
  });
}

function beginMinimizePrompt(kind: MinimizePromptKind): void {
  // A prompt is already on screen — it covers this attempt too; the pending
  // fail-safe still guarantees the window eventually minimizes/closes.
  if (minimizePromptPending) return;
  const win = liveWindow();
  if (!win) return;
  win.webContents.send('app:minimize-prompt', { kind });
  const failsafe = setTimeout(() => {
    minimizePromptPending = null;
    proceedWithMinimizeDefault(kind);
  }, MINIMIZE_PROMPT_FAILSAFE_MS);
  minimizePromptPending = { kind, failsafe };
}

function proceedWithMinimizeDefault(kind: MinimizePromptKind): void {
  const win = liveWindow();
  if (!win) return;
  if (kind === 'minimize') {
    suppressNextMinimize = true;
    win.minimize();
  } else {
    suppressNextClose = true;
    win.close();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'AhaStation',
    backgroundColor: getThemeBackgroundColor(),
    // hiddenInset only works on macOS; Windows/Linux use the default title bar.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox: true is safe here — preload.cjs only uses ipcRenderer +
      // contextBridge, both of which are sandbox-compatible. Keeping the OS
      // sandbox on means a renderer compromise (XSS in transcript, vuln in
      // Electron's HTML/JS engine) can't directly call native fs / exec.
      sandbox: true,
    },
  });

  // B11: the OS will reap the BrowserWindow after 'closed', but our module
  // binding keeps pointing at the destroyed instance. Without this, any
  // subsequent emitToRenderer / dialog handler hits "Object has been
  // destroyed" on .webContents access — the isDestroyed() guards in
  // liveWindow() are belt-and-braces for that same case.
  mainWindow.on('closed', () => {
    mainWindow = null;
    browserTabManager.destroy();
    // The window is gone — drop any unanswered prompt state so a future
    // minimize/close of the recreated window starts clean.
    if (minimizePromptPending) {
      clearTimeout(minimizePromptPending.failsafe);
      minimizePromptPending = null;
    }
  });

  // Minimize/close → AhaBar prompt: hold the window action and ask the
  // renderer, unless the bar is already floating or the user opted out
  // (settings.ahaBarPromptDisabled). Both events are cancellable — though
  // the d.ts types 'minimize' as listener: () => void, at runtime Electron
  // still delivers a cancellable event (the long-standing minimize-to-tray
  // pattern), hence the local cast.
  mainWindow.on('minimize', ((event: Electron.Event) => {
    if (suppressNextMinimize) {
      suppressNextMinimize = false;
      return;
    }
    if (!minimizePromptGateOpen()) return;
    event.preventDefault();
    beginMinimizePrompt('minimize');
  }) as () => void);

  mainWindow.on('close', (event) => {
    if (suppressNextClose) {
      suppressNextClose = false;
      return;
    }
    if (!minimizePromptGateOpen()) return;
    event.preventDefault();
    beginMinimizePrompt('close');
  });

  // Wire the embedded browser to the main window so it can add/remove
  // WebContentsView child views.
  browserTabManager.setWindow(mainWindow);

  // Re-sync embedded browser bounds when the window is moved or resized,
  // since the renderer's ResizeObserver may not fire for window-level changes.
  // (Bounds are actually handled by the renderer's own ResizeObserver — no
  // action needed from the main process side. The listeners were previously
  // no-ops and have been removed.)

  // Security headers are kept in a side-effect-free module so packaged VAD/
  // ONNX requirements and dev HMR exceptions are contract-tested.
  const securityHeaders = buildRendererSecurityHeaders({
    isDev,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        ...securityHeaders,
      },
    });
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('app://bundle/index.html');
    if (process.env.VIBE_MEET_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  }

  // DevTools toggle: Cmd+Option+I (mac) / Ctrl+Shift+I (others). Packaged
  // builds otherwise have no UI to open DevTools, which leaves the user
  // stuck if they need to read renderer logs (e.g. the [asr] probe line
  // that reports whether Xunfei ASR is live).
  const wc = mainWindow.webContents;
  wc.on('before-input-event', (_e, input) => {
    if (!isDev && !process.env.VIBE_MEET_DEVTOOLS) return;
    if (input.type !== 'keyDown') return;
    if (input.key.toLowerCase() !== 'i') return;
    const combo = process.platform === 'darwin'
      ? input.meta && input.alt
      : input.control && input.shift;
    if (!combo) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  });

  // Lock down navigation. The renderer should only ever live at our Vite dev
  // URL (dev) or our packaged file:// HTML (prod) — anything else (a stray
  // <a href>, a malicious tool-result-injected URL, a window.open) must NOT
  // turn this BrowserWindow into a generic web browser.
  const allowedOrigin = isDev
    ? new URL(process.env.VITE_DEV_SERVER_URL!).origin
    : 'file://';

  // window.open / target="_blank" → route external links to the OS browser
  // and refuse to spawn a new Electron window for them.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch { /* ignore unparseable URLs */ }
    return { action: 'deny' };
  });

  // Any in-window navigation away from our app origin gets cancelled. http(s)
  // links go to the user's default browser; everything else is silently
  // dropped (could be a custom-scheme attack vector).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const u = new URL(url);
      const sameOrigin = isDev
        ? u.origin === allowedOrigin
        : u.protocol === 'file:';
      if (sameOrigin) return;
      event.preventDefault();
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        void shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
}

function emitToRenderer(e: IpcEmittedEvent) {
  const win = liveWindow();
  if (!win) return;
  // Flatten { source, event } onto each event so the renderer's RendererEvent
  // shape stays a single object with an extra `source` field. sessionId is
  // pre-bound by the per-slot emit wrapper created in sessions:open so the
  // renderer can route the event to the right MeetingState slot. hostId is
  // added by the orchestrator's safeEmit wrapper (defaults to 'default').
  win.webContents.send('session:event', { ...e.event, source: e.source, sessionId: e.sessionId, hostId: e.hostId });
  // Companion screen tap (Phase 8): the same orchestrator stream feeds the
  // pixel-office model — point-to-point to the companion window inside.
  getCompanionFeed()?.onOrchestratorEvent(e);
}

// S3: under auto-approve, render a short preview of the tool call for the
// native dialog so the user can decide without context-switching to the
// renderer (and without trusting the renderer to render it faithfully).
function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'KillBash':
      return truncate(`$ ${str(input.command)}`, 400);
    case 'Write':
      return truncate(`Write → ${str(input.file_path)}`, 400);
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return truncate(`Edit → ${str(input.file_path) || str(input.notebook_path)}`, 400);
    case 'SlashCommand':
      return truncate(`/${str(input.command)}`, 400);
    case 'mcp__computer-use__screenshot':
      return 'Screenshot';
    case 'mcp__computer-use__mouse_click':
      return truncate(`Click ${str(input.button) || 'left'} at (${input.x}, ${input.y})`, 400);
    case 'mcp__computer-use__mouse_move':
      return truncate(`Move to (${input.x}, ${input.y})`, 400);
    case 'mcp__computer-use__keyboard_type':
      return truncate(`Type: "${str(input.text)}"`, 400);
    case 'mcp__computer-use__keyboard_press':
      return truncate(`Press: ${str(input.key)}`, 400);
    case 'mcp__computer-use__scroll':
      return truncate(`Scroll ${str(input.direction)} at (${input.x}, ${input.y})`, 400);
    default:
      try {
        return truncate(JSON.stringify(input), 400);
      } catch {
        return '(input not serializable)';
      }
  }
}

// S3: native OS confirmation for destructive tool calls under auto-approve.
// A compromised renderer (XSS, injected script) could fake the in-app
// permission row and flip auto-approve on, but it cannot synthesize a click
// on this OS-level modal — that's the whole point. Defaults to Deny so even
// a stuck-Enter scenario doesn't run something destructive.
async function nativeConfirmDestructive(
  toolName: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const win = liveWindow();
  if (!win) return false;
  // Surface the window first: a window-modal sheet on an unfocused/minimized
  // app is effectively invisible, so the worker would block on this promise
  // with no on-screen signal (one of the "silent blocker" symptoms).
  try {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } catch (err) {
    console.warn('[main] failed to surface window for destructive confirm:', err);
  }
  const detail = summarizeToolInput(toolName, input);
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '自动批准：确认高风险操作',
    message: `Worker 请求执行：${toolName}`,
    detail,
    buttons: ['拒绝', '允许'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return res.response === 1;
}

// ---- Observation layer (S0) -------------------------------------------------
// One ObserveService per app: scans for externally-launched claude/codex CLI
// sessions and republishes each full snapshot to every window ('observe:event')
// — the task board mixes those cards in next to orchestrated tasks. Pure-Node
// and fault-isolated; started on app ready, stopped on quit.

let lastObservedSnapshot: ObservedSnapshot = { sessions: [], scannedAt: 0 };

// Self-exclusion, PID side: app-spawned CLI backends are children of this
// process (subprocess-backend spawn), so the whole descendant tree is hidden
// from the observer. getSelfExclusion is sync, so the tree is refreshed
// lazily on the service's own tick cadence — the previous tree is served
// while a ps refresh is in flight.
let selfPidTree: Set<number> = new Set([process.pid]);
let selfPidTreeAt = 0;
let selfPidTreeRefreshing = false;
const SELF_PID_TREE_TTL_MS = 2_000;
const SELF_PID_TREE_MAX_DEPTH = 8;

function selfExclusionPids(): Set<number> {
  if (!selfPidTreeRefreshing && Date.now() - selfPidTreeAt > SELF_PID_TREE_TTL_MS) {
    selfPidTreeRefreshing = true;
    void captureProcessSnapshot()
      .then((snapshot) => {
        const tree = descendantsOf(snapshot, process.pid, SELF_PID_TREE_MAX_DEPTH);
        tree.add(process.pid);
        selfPidTree = tree;
        selfPidTreeAt = Date.now();
      })
      .catch(() => { /* ps failed — keep serving the previous tree */ })
      .finally(() => { selfPidTreeRefreshing = false; });
  }
  return selfPidTree;
}

// Self-exclusion, session-id side.
// TODO(S1): collect native session ids (Claude SDK session_id, Codex thread
// id) from the live SessionRegistry orchestrators/workers so transcripts
// written by app-spawned sessions are excluded too. The PID tree above hides
// their live processes; the residual gap is a file-only row lingering after
// an app worker's process exits.
function selfExclusionSessionIds(): Set<string> {
  return new Set();
}

const observeService = new ObserveService({
  homeDir: homedir(),
  publish: (snapshot) => {
    lastObservedSnapshot = snapshot;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('observe:event', snapshot);
    }
  },
  getSelfExclusion: () => ({
    pids: selfExclusionPids(),
    sessionIds: selfExclusionSessionIds(),
  }),
});

// ---- Wire IPC domain modules -----------------------------------------------
// Each domain module registers its own ipcMain.handle() calls. State that
// crosses domains (orchestrator, autoApprove, etc.) flows through the shared
// IpcContext so domain modules stay pure and testable.

const ipcCtx: IpcContext = {
  liveWindow,
  emitToRenderer,
  registry,
  getOrchestrator: (id) => registry.resolve(id)?.orchestrator ?? null,
  getCurrentCwd: (id) => registry.resolve(id)?.cwd ?? null,
  getSlot: (id) => registry.resolve(id),
  getAutoApprove: () => autoApprove,
  setAutoApprove: (v) => { autoApprove = v; },
  getClaudeShadowHome: () => claudeShadowHome,
  awaitClaudeShadowHome,
  nativeConfirmDestructive,
  browserTabManager,
};

// Resolved lazily inside whenReady(); cached here so before-quit can access it.
let _flushOpenTabsNow: ((ctx: IpcContext) => void) | null = null;

async function registerAllIpc(ctx: IpcContext): Promise<void> {
  const [
    { registerSessionIpc },
    { registerSessionsIpc, flushOpenTabsNow },
    { registerAuthIpc },
    { registerDesktopIpc },
    { registerAsrIpc },
    { registerSettingsIpc },
    { registerSettingsWindowIpc },
    { registerMemoryIpc },
    { registerDecisionIpc },
    { registerDialogIpc },
    { registerAttachmentsIpc },
    { registerDocumentsIpc },
    { registerTasksIpc },
    { registerTranscriptsIpc },
    { registerAccessibilityIpc },
    { registerSkillsIpc },
    { registerBrowserIpc },
    { registerBackendAuthIpc },
    { registerPopoutWindowIpc },
    { registerOpenCodeEditorIpc },
    { registerIdeFilesIpc },
    { registerIdeRegistryIpc },
    { registerIdePtyIpc },
    { registerDeviceDiagnosticsIpc },
    { registerMeetingDeliveryIpc },
    { registerCompanionIpc },
  ] = await Promise.all([
    import('./ipc/session.js'),
    import('./ipc/sessions.js'),
    import('./ipc/auth.js'),
    import('./ipc/desktop.js'),
    import('./ipc/asr.js'),
    import('./ipc/settings.js'),
    import('./ipc/settings-window.js'),
    import('./ipc/memory.js'),
    import('./ipc/decision.js'),
    import('./ipc/dialog.js'),
    import('./ipc/attachments.js'),
    import('./ipc/documents.js'),
    import('./ipc/tasks.js'),
    import('./ipc/transcripts.js'),
    import('./ipc/accessibility.js'),
    import('./ipc/skills.js'),
    import('./ipc/browser.js'),
    import('./ipc/backend-auth.js'),
    import('./ipc/popout-window.js'),
    import('./ipc/opencode-editor.js'),
    import('./ipc/ide-files.js'),
    import('./ipc/ide-registry.js'),
    import('./ipc/ide-pty.js'),
    import('./ipc/device-diagnostics.js'),
    import('./ipc/meeting-delivery.js'),
    import('./companion/companion-feed.js'),
  ]);
  _flushOpenTabsNow = flushOpenTabsNow;
  registerSessionIpc(ctx);
  registerSessionsIpc(ctx);
  registerAuthIpc();
  registerDesktopIpc();
  registerAsrIpc();
  registerSettingsIpc();
  registerSettingsWindowIpc();
  registerMemoryIpc(ctx);
  registerDecisionIpc();
  registerDialogIpc(ctx);
  registerAttachmentsIpc(ctx);
  registerDocumentsIpc(ctx);
  registerTasksIpc(ctx);
  registerTranscriptsIpc(ctx);
  registerAccessibilityIpc();
  registerSkillsIpc();
  registerBrowserIpc(browserTabManager);
  registerBackendAuthIpc();
  registerPopoutWindowIpc();
  registerOpenCodeEditorIpc(ctx);
  registerIdeFilesIpc();
  registerIdeRegistryIpc(ctx);
  registerIdePtyIpc(ctx);
  registerDeviceDiagnosticsIpc();
  registerMeetingDeliveryIpc(ctx);
  registerCompanionIpc(ctx);
  // Register custom backends from settings so they appear in the backend list
  registerCustomBackends();
}

// ---- App lifecycle ----------------------------------------------------------

// GPU crash fallback for no-GL environments (RK3588 without a working Mali
// driver, RDP/VM software rendering): Chromium FATAL-exits the whole app
// after 6 GPU-process crashes. Escape hatch — count crashes, and at the 3rd
// one persist a marker in userData and relaunch; on the next launch the
// marker applies app.disableHardwareAcceleration() BEFORE ready so Chromium
// never spawns a real GPU process. Manual override: AHASTATION_DISABLE_GPU=1.
// To re-enable GPU after a driver fix, delete the marker file.
const GPU_CRASH_MARKER = join(app.getPath('userData'), '.gpu-disabled');
const GPU_CRASH_LIMIT = 3;
let gpuCrashCount = 0;

if (process.env.AHASTATION_DISABLE_GPU === '1' || existsSync(GPU_CRASH_MARKER)) {
  app.disableHardwareAcceleration();
}

app.on('child-process-gone', (_event, details) => {
  if (details.type !== 'GPU' || details.reason === 'killed') return;
  gpuCrashCount += 1;
  if (gpuCrashCount === GPU_CRASH_LIMIT) {
    console.error('[gpu] GPU process crashed 3 times — relaunching with hardware acceleration disabled');
    try {
      writeFileSync(GPU_CRASH_MARKER, String(Date.now()));
    } catch (err) {
      console.error('[gpu] failed to persist crash marker:', err);
    }
    app.relaunch();
    app.exit(0);
  }
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = liveWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  registerAppProtocol();
  // Dynamic-import IPC modules so their transitive deps (orchestrator,
  // claude-session, ASR, etc.) don't block the app-ready event.
  // IPC handlers must be registered before createWindow() so the renderer
  // can call them as soon as it loads — but the dynamic import resolves in
  // <50ms (all local files, no network) which is faster than the original
  // synchronous ESM resolution of the same tree.
  await registerAllIpc(ipcCtx);

  // Observation layer: snapshot pull + start scanning (broadcasts via publish).
  ipcMain.handle('observe:getSnapshot', () => lastObservedSnapshot);
  observeService.start();

  // Minimize/close → AhaBar prompt: the renderer's answer. 'ahabar' floats the
  // bar, then minimizes (minimize path) or hides the window (close path —
  // hiding instead of destroying keeps sessions and the voice link alive,
  // which is the point of enabling the bar). 'hide' replays the original
  // minimize/close semantics. `never` persists the 不再提示 opt-out.
  handleSecure('app:minimize-choice', {
    schema: z.object({
      action: z.enum(['ahabar', 'hide']),
      never: z.boolean(),
    }).strict(),
    authorize: mainWindowSenderPolicy(() => liveWindow()?.webContents.id ?? null),
    handler: async (choice) => {
      const pending = minimizePromptPending;
      if (!pending) return { ok: false, error: 'No minimize prompt pending' };
      minimizePromptPending = null;
      clearTimeout(pending.failsafe);
      if (choice.never) {
        await updateSettings({ ahaBarPromptDisabled: true }).catch((err) => {
          console.warn('[main] failed to persist ahaBarPromptDisabled:', err);
        });
      }
      const win = liveWindow();
      if (!win) return { ok: true };
      switch (resolveMinimizeOutcome(pending.kind, choice)) {
        case 'open-ahabar-minimize':
          toggleCompanionWindow('ahabar');
          suppressNextMinimize = true;
          win.minimize();
          break;
        case 'open-ahabar-hide':
          toggleCompanionWindow('ahabar');
          win.hide();
          break;
        case 'minimize':
          suppressNextMinimize = true;
          win.minimize();
          break;
        case 'close':
          suppressNextClose = true;
          win.close();
          break;
      }
      return { ok: true };
    },
  });

  // Kick the merged bundled+user .claude shadow tree build OFF the launch
  // critical path. createWindow() fires immediately so Chromium starts up in
  // parallel; sessions:open awaits the resulting promise the first time it
  // needs HOME (usually 1–3 s after launch — the build is done long before).
  import('./claude-defaults.js').then(({ buildClaudeShadowHome }) => {
    claudeShadowHomeReady = buildClaudeShadowHome().then(
      (result) => {
        claudeShadowHome = result.home;
        if (claudeShadowHome) {
          import('./skills.js').then(({ setShadowSkillsDir }) => {
            setShadowSkillsDir(claudeShadowHome);
          }).catch((err) => {
            console.error('[claude-defaults] failed to set shadow skills dir:', err);
          });
          const cachedSuffix = result.stats.cached ? ' [cached]' : '';
          console.log(
            `[claude-defaults] shadow home at ${claudeShadowHome} ` +
              `(bundled=${result.stats.bundled} userOverrides=${result.stats.userOverrides} passthrough=${result.stats.passthrough})${cachedSuffix}`,
          );
        } else {
          console.log('[claude-defaults] dev mode or no bundled defaults; using real ~/.claude');
        }
        return claudeShadowHome;
      },
      (err) => {
        console.error('[claude-defaults] failed to build shadow home:', err);
        claudeShadowHome = null;
        return null;
      },
    );
  }).catch((err) => {
    console.error('[main] claude-defaults import failed:', err);
  });

  createWindow();

  // Pragmatic update probe (Phase 6b §3.5-5): anonymous redirect parse of
  // releases/latest, 24h-cached. Silently no-ops while the repo is private
  // (anonymous 404) — starts working the day it goes public.
  void checkForUpdateCached(app.getVersion()).then((r) => {
    if (!r.available) return;
    const win = liveWindow();
    win?.webContents.send('update-available', { latest: r.latest, url: r.url });
  });

  // Dual-display migration (Phase 6a §3.2): moving windows only adjusts
  // BrowserWindow bounds — webContents is NEVER rebuilt, so the voice link
  // and all meeting state survive. The display-changed notification lets
  // the renderer re-evaluate its handheld heuristic and run the
  // overlay ↔ window form-factor migration itself.
  const notifyDisplayChanged = (added: boolean) => {
    const win = liveWindow();
    if (!win) return;
    win.webContents.send('display-changed', {
      displayCount: electronScreen.getAllDisplays().length,
      added,
    });
  };

  electronScreen.on('display-added', () => {
    // Move the main window onto the new external display's work area.
    const win = liveWindow();
    const displays = electronScreen.getAllDisplays();
    const external = displays.find((d) => d.internal === false)
      ?? displays.find((d) => d.id !== electronScreen.getPrimaryDisplay().id)
      ?? null;
    if (win && external) {
      win.setBounds(external.workArea);
    }
    notifyDisplayChanged(true);
  });

  electronScreen.on('display-removed', () => {
    // Gather every window back onto the primary display.
    const primary = electronScreen.getPrimaryDisplay().workArea;
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      const b = win.getBounds();
      const outside = b.x < primary.x || b.y < primary.y
        || b.x >= primary.x + primary.width || b.y >= primary.y + primary.height;
      if (outside) {
        win.setBounds({
          x: primary.x + 40,
          y: primary.y + 40,
          width: Math.min(b.width, primary.width - 80),
          height: Math.min(b.height, primary.height - 80),
        });
      }
    }
    notifyDisplayChanged(false);
  });

  // Keep the window chrome in sync when the user switches system light/dark
  // mode while the app is running. The renderer CSS follows prefers-color-scheme
  // automatically; this only updates Electron's native background color.
  nativeTheme.on('updated', () => {
    const win = liveWindow();
    if (win) {
      win.setBackgroundColor(getThemeBackgroundColor());
    }
  });

  // Wait until the first window is actually visible before asking for mic.
  // Calling the macOS permission API while the window is still hidden can
  // leave the consent sheet behind other apps and makes a first install look
  // as if no native prompt was shown.
  const requestMicWhenVisible = () => {
    // Small delay so the window has time to come to the front on macOS.
    setTimeout(() => {
      void requestMicrophoneAccess(false).then((granted) => {
        console.log('[mic-permission] first-window request result:', granted);
      }).catch((err) => {
        console.warn('[mic-permission] first-window request failed:', err);
      });
    }, 300);
  };

  if (mainWindow) {
    if (mainWindow.isVisible()) {
      requestMicWhenVisible();
    } else {
      mainWindow.once('show', requestMicWhenVisible);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      return;
    }
    // The AhaBar close path hides the main window instead of destroying it —
    // a dock click must be able to bring it back.
    const win = liveWindow();
    if (win && !win.isVisible() && !win.isMinimized()) {
      win.show();
      win.focus();
    }
  });
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tears down every live slot. Orchestrator.end() returns a Promise that
// resolves once async cleanup (recap, etc.) finishes — we collect those so
// callers can await the whole fleet before letting Electron exit. Registry
// entries are dropped synchronously up front; the async work continues to
// run against detached orchestrator instances.
function shutdownAllSlots(): Promise<void> {
  const endPromises: Promise<void>[] = [];
  for (const slot of registry.values()) {
    try {
      endPromises.push(slot.orchestrator.end());
    } catch {
      /* ignore — best-effort teardown */
    }
  }
  for (const slot of [...registry.values()]) {
    registry.close(slot.id);
  }
  return Promise.all(endPromises).then(() => undefined);
}

app.on('window-all-closed', () => {
  void shutdownAllSlots();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Final safety net: even on cmd-Q with the dock alive (macOS) the window-all-
// closed handler doesn't fire. before-quit covers that path so slots and
// pending settings writes always drain before exit.
//
// v0.7.3: Electron used to terminate this process the moment the handler
// returned, killing recap + SDK subprocess teardown mid-flight and leaving
// zombie children behind. Now we preventDefault, await teardown (capped at
// 5s so a stuck recap can't block Cmd-Q indefinitely), then app.exit(0).
let isQuitting = false;
app.on('before-quit', (event) => {
  if (isQuitting) {
    // Re-entrant — let Electron actually quit this time.
    return;
  }
  isQuitting = true;
  event.preventDefault();
  observeService.stop();

  void (async () => {
    // Close settings window early so it doesn't linger during teardown
    import('./ipc/settings-window.js')
      .then(({ closeSettingsWindow }) => closeSettingsWindow())
      .catch(() => { /* ignore — settings window may not exist */ });
    import('./ipc/popout-window.js')
      .then(({ closeAllPopoutWindows }) => closeAllPopoutWindows())
      .catch(() => { /* ignore */ });

    try {
      await Promise.race([shutdownAllSlots(), sleepMs(5000)]);
    } finally {
      if (_flushOpenTabsNow) _flushOpenTabsNow(ipcCtx);
      await flushSettingsWrites();
      app.exit(0);
    }
  })();
});
