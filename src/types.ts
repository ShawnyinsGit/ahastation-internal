export type AutoApproveScope = 'off' | 'read' | 'all';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
}

// ── OpenCode editor live panels (Phase 2 PR③) ──────────────────────────────
// Mirror of electron/backends/opencode-editor-panel.ts shapes (kept in sync
// by hand; the two tsconfigs don't share sources).

export type EditorStatus = 'idle' | 'busy' | 'retry' | 'error';

export interface EditorTodoItem {
  id: string;
  content: string;
  status: string;
  priority: string;
}

export interface EditorDiffEntry {
  file: string;
  additions: number;
  deletions: number;
}

export interface EditorActivityItem {
  ts: number;
  kind: 'text' | 'tool' | 'status' | 'file' | 'info';
  label: string;
  detail?: string;
}

export interface EditorKeyedActivity {
  key: string;
  item: EditorActivityItem;
}

export interface EditorSnapshot {
  status: EditorStatus;
  todos: EditorTodoItem[];
  diff: EditorDiffEntry[];
  activity: EditorKeyedActivity[];
}

export type EditorPanelEvent =
  | { kind: 'activity-upsert'; key: string; item: EditorActivityItem }
  | { kind: 'status'; status: EditorStatus }
  | { kind: 'todo'; todos: EditorTodoItem[] }
  | { kind: 'diff'; diff: EditorDiffEntry[] };

export const EDITOR_ACTIVITY_CAP = 200;

export type AgentSource = 'talker' | string;

export type WorkerStatus = 'pending' | 'running' | 'interrupted' | 'done' | 'failed';

export type WorkerSpecialty =
  | 'general'
  | 'frontend'
  | 'backend'
  | 'electron'
  | 'devops'
  | 'test'
  | 'docs'
  | 'review'
  | 'computer-use';

export interface WorkerTaskHistoryEntry {
  id: string;
  title: string;
  status: WorkerStatus;
  startedAt: number;
  finishedAt: number;
  summary?: string;
}

export interface MeetingPlanNode {
  id: string;
  title: string;
  status: WorkerStatus;
  deps: string[];
}

export interface MeetingPlan {
  nodes: MeetingPlanNode[];
}

/** One file delivered by a worker turn. Path is absolute; the renderer
 *  fetches contents via `documents.read`. */
export interface WorkerDeliveryFile {
  path: string;
  snapshotRelativePath?: string;
}

/** Every event from main is tagged with the sessionId of the slot that
 *  emitted it. Renderer's multi-slot store routes the event to the right
 *  MeetingState by id; absent or unknown ids are dropped. */
export type RendererEvent =
  | { kind: 'message'; message: any; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'permission-request'; id: string; toolName: string; input: Record<string, unknown>; toolUseID: string; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'permission-cancelled'; id: string; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'auth-required'; error: string; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'error'; error: string; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'ended'; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'worker-spawned'; workerId: string; title: string; deps: string[]; specialty: WorkerSpecialty; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'worker-ended'; workerId: string; status: WorkerStatus; summary?: string; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'worker-stalled'; workerId: string; title: string; idleMs: number; currentTool: string | null; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'worker-delivery'; workerId: string; title: string; summary: string; taskId: string; files: WorkerDeliveryFile[]; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'plan-updated'; plan: MeetingPlan; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'plan-proposed'; tasks: PlanMeetingTaskInput[]; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'coordinator-failed'; hostId: string; candidateHostId: string | null; error?: string; source?: AgentSource; sessionId?: string }
  | { kind: 'decision-pending'; decisionId: string; question: string; path: string; recommendedTitle: string; calendarOk: boolean; remindersOk: boolean; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'decision-resolved'; decisionId: string; question: string; path: string; conclusion: string; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'document-saved'; title: string; filename: string; path: string; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'session-ready'; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'session-start-failed'; error: string; source?: AgentSource; sessionId?: string; hostId?: string };

export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
}

export interface VoicePrint {
  embedding: number[];
  model: string;
  secondsCaptured: number;
  enrolledAt: number;
}

export type MemoryCategory = 'point' | 'decision' | 'todo' | 'fact';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  content: string;
  tags: string[];
  projectId: string;
  sourceMeetingId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryListFilter {
  projectId?: string;
  category?: MemoryCategory;
  query?: string;
}

export interface MemoryUpdatePatch {
  category?: MemoryCategory;
  content?: string;
  tags?: string[];
}

export interface MemoryApi {
  list: (
    filter?: MemoryListFilter | null,
  ) => Promise<{ ok: true; entries: MemoryEntry[] } | { ok: false; error: string }>;
  update: (
    id: string,
    patch: MemoryUpdatePatch,
  ) => Promise<{ ok: true; entry: MemoryEntry } | { ok: false; error: string }>;
  delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  currentProjectId: (sessionId?: string | null) => Promise<string | null>;
}

export interface AuthApi {
  getConfig: () => Promise<{
    authMode: 'apikey' | 'subscription' | null;
    hasApiKey: boolean;
    baseUrl: string | null;
    model: string | null;
  }>;
  setApiKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  setBaseUrl: (url: string) => Promise<{ ok: boolean; error?: string }>;
  setModel: (model: string) => Promise<{ ok: boolean; error?: string }>;
  setMode: (mode: 'apikey' | 'subscription' | null) => Promise<{ ok: boolean; error?: string }>;
  loginSubscription: () => Promise<{ ok: boolean; error?: string }>;
  checkSubscriptionStatus: () => Promise<{ loggedIn: boolean }>;
}

export interface BackendInfo {
  id: string;
  displayName: string;
  iconId: string;
  available: boolean;
  binaryPath: string | null;
  authMode: 'apikey' | 'oauth' | 'none';
  hasApiKey: boolean;
  /** Whether an auth entry exists for this backend at all. */
  hasAuthEntry: boolean;
  /** Result of the backend's live credential probe. */
  loggedIn: boolean;
  baseUrl: string | null;
  model: string | null;
  defaultModel: string | null;
  models: string[] | null;
  isDefault: boolean;
  installHint: string | null;
  supportsMcp: boolean;
  supportsPermissions: boolean;
  supportsCoordinator: boolean;
  supportsWorkers: boolean;
  /** Custom avatar image as base64 data URL. */
  customAvatar: string | null;
}

export interface BackendAuthApi {
  list: () => Promise<BackendInfo[]>;
  getConfig: (backendId: string) => Promise<{
    ok: boolean;
    config: {
      authMode: 'apikey' | 'oauth' | 'none';
      hasApiKey: boolean;
      baseUrl: string | null;
      model: string | null;
      lastValidatedAt: number | null;
    } | null;
    error?: string;
  }>;
  setApiKey: (backendId: string, key: string) => Promise<{ ok: boolean; error?: string }>;
  setBaseUrl: (backendId: string, url: string) => Promise<{ ok: boolean; error?: string }>;
  setModel: (backendId: string, model: string) => Promise<{ ok: boolean; error?: string }>;
  setMode: (backendId: string, mode: 'apikey' | 'oauth' | 'none') => Promise<{ ok: boolean; error?: string }>;
  setAvatar: (backendId: string, dataUrl: string | null) => Promise<{ ok: boolean; error?: string }>;
  setDefault: (backendId: string) => Promise<{ ok: boolean; error?: string }>;
  checkStatus: (backendId: string) => Promise<{ ok: boolean; loggedIn: boolean; error?: string }>;
  loginOAuth: (backendId: string) => Promise<{ ok: boolean; error?: string }>;
  install: (backendId: string) => Promise<{ ok: boolean; error?: string }>;
  onInstallProgress: (cb: (data: { backendId: string; data: string }) => void) => () => void;
}

export interface CustomBackendInfo {
  id: string;
  displayName: string;
  binaryName: string;
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  defaultModel?: string;
  installHint?: string;
  npmPackage?: string;
  createdAt: number;
}

export interface CustomBackendApi {
  list: () => Promise<CustomBackendInfo[]>;
  add: (payload: {
    id: string;
    displayName: string;
    binaryName: string;
    apiKeyEnv?: string;
    baseUrlEnv?: string;
    defaultModel?: string;
    installHint?: string;
    npmPackage?: string;
  }) => Promise<{ ok: true; entry: CustomBackendInfo } | { ok: false; error: string }>;
  update: (payload: { id: string } & Partial<Omit<CustomBackendInfo, 'id' | 'createdAt'>>) => Promise<{ ok: boolean; error?: string }>;
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
}

export type AttachmentKind = 'text' | 'image' | 'word' | 'pdf';

export interface StagedAttachment {
  id: string;
  name: string;
  mime: string;
  sizeBytes: number;
  kind: AttachmentKind;
  /** Base64 payload sent across IPC; cleared after send. */
  dataBase64: string;
}

export interface AttachmentMeta {
  name: string;
  kind: AttachmentKind;
  sizeBytes: number;
}

export interface AttachmentSendWire {
  name: string;
  mime: string;
  sizeBytes: number;
  dataBase64: string;
}

/** Tab/meeting metadata describing one open slot. Returned by sessions:list. */
export interface SessionMeta {
  id: string;
  cwd: string;
  openedAt: number;
  lastActivityAt: number;
}

export interface RecentCwdMeta {
  path: string;
  lastOpenedAt: number;
}

export interface OpenTabMeta {
  cwd: string;
  openedAt: number;
}

export interface HostMeta {
  id: string;
  backendId: string;
  role: 'coordinator' | 'expert';
}

export interface SessionsApi {
  open: (
    cwd: string,
    greeting?: string,
    backendId?: string,
    recoveryMeetingId?: string,
  ) => Promise<
    | { ok: true; sessionId: string; cwd: string; backendId?: string; recovered?: boolean; status?: 'starting' }
    | { ok: false; error: 'duplicate'; sessionId: string; cwd?: string }
    | { ok: false; error: string }
  >;
  close: (id: string) => Promise<{ ok: boolean; activeId?: string | null; error?: string }>;
  setActive: (id: string) => Promise<{ ok: boolean; error?: string }>;
  list: () => Promise<{ ok: true; sessions: SessionMeta[]; activeId: string | null }>;
  listRestore: () => Promise<{
    ok: true;
    openTabs: OpenTabMeta[];
    recentCwds: RecentCwdMeta[];
    lastActiveCwd: string | null;
  }>;
  listRecoverable: () => Promise<{ ok: true; meetings: Array<{ meetingId: string; seq: number; state: Record<string, unknown> }> }>;
  resolveRecoveredTask: (
    sessionId: string | null,
    taskId: string,
    action: 'continue' | 'retry' | 'complete' | 'abandon',
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  addHost: (
    sessionId: string | null,
    backendId: string,
    hostId?: string,
  ) => Promise<{ ok: true; hostId: string } | { ok: false; error: string }>;
  removeHost: (
    sessionId: string | null,
    hostId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  listHosts: (
    sessionId: string | null,
  ) => Promise<{ ok: true; hosts: HostMeta[] } | { ok: false; error: string }>;
  setCoordinator: (
    sessionId: string | null,
    hostId: string,
  ) => Promise<{ ok: true; coordinatorHostId: string } | { ok: false; error: string }>;
  restartHost: (
    sessionId: string | null,
    hostId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface SkillInfo {
  name: string;
  description: string;
  source: 'bundled' | 'user';
  path: string;
}

export interface SkillsApi {
  list: () => Promise<{ ok: true; skills: SkillInfo[] } | { ok: false; error: string }>;
  install: (source: string) => Promise<{ ok: true; skill: SkillInfo } | { ok: false; error: string }>;
  uninstall: (name: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserStateSnapshot {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  visible: boolean;
}

export interface BrowserApi {
  openTab: (url?: string) => Promise<{ ok: true; tab: BrowserTabInfo } | { ok: false; error: string }>;
  closeTab: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  setActive: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  navigate: (tabId: string, url: string) => Promise<{ ok: boolean }>;
  back: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  forward: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  reload: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  setBounds: (bounds: { x: number; y: number; width: number; height: number; dpr: number }) => Promise<{ ok: true } | { ok: false; error: string }>;
  setVisible: (visible: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  getState: () => Promise<BrowserStateSnapshot>;
  capturePage: (tabId?: string) => Promise<{ ok: true; pngBase64: string; width: number; height: number } | { ok: false; error: string }>;
  onStateUpdate: (cb: (state: BrowserStateSnapshot) => void) => () => void;
}

export interface VibeMeetApi {
  sessions: SessionsApi;
  sendUserText: (sessionId: string | null, text: string) => Promise<{ ok: boolean; error?: string }>;
  sendUserImage: (sessionId: string | null, dataUrl: string, caption: string) => Promise<{ ok: boolean; error?: string }>;
  sendUserAttachments: (
    sessionId: string | null,
    items: AttachmentSendWire[],
    caption: string,
  ) => Promise<{ ok: boolean; error?: string; inlinedCount?: number; workspaceCount?: number }>;
  resolvePermission: (sessionId: string | null, id: string, decision: 'allow' | 'deny', message?: string) => Promise<{ ok: boolean }>;
  interrupt: (sessionId: string | null) => Promise<{ ok: boolean }>;
  setPermissionMode: (sessionId: string | null, mode: string) => Promise<{ ok: boolean }>;
  setAutoApprove: (scope: AutoApproveScope) => Promise<{ ok: boolean; autoApproveScope?: AutoApproveScope }>;
  setOrchestrationMode: (sessionId: string | null, enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
  approvePlan: (sessionId: string | null, approved: boolean) => Promise<{ ok: boolean; error?: string }>;
  endSession: (sessionId: string | null) => Promise<{ ok: boolean }>;
  pickCwd: () => Promise<string | null>;
  getVoiceConfig: () => Promise<{ enabled: boolean; voicePrint: VoicePrint | null }>;
  setVoiceLockEnabled: (on: boolean) => Promise<{ ok: boolean }>;
  setVoicePrint: (vp: VoicePrint | null) => Promise<{ ok: boolean }>;
  getVoicePref: () => Promise<{ selectedVoiceName: string | null; guidanceDismissed: boolean; speechFilterMode: 'strict' | 'off'; voicePolishEnabled: boolean; reportModeEnabled: boolean }>;
  setVoicePref: (patch: { selectedVoiceName?: string | null; guidanceDismissed?: boolean; speechFilterMode?: 'strict' | 'off'; voicePolishEnabled?: boolean; reportModeEnabled?: boolean }) => Promise<{ ok: boolean }>;
  openVoiceSettings: () => Promise<{ ok: boolean }>;
  useSystemPicker: () => Promise<boolean>;
  getDesktopSources: () => Promise<
    | { ok: true; sources: DesktopSource[] }
    | { ok: false; error: string; status: string }
  >;
  checkScreenPermission: () => Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>;
  openScreenSettings: () => Promise<{ ok: boolean }>;
  relaunchApp: () => Promise<void>;
  requestMicPermission: () => Promise<boolean>;
  asrAvailable: () => Promise<{ ok: boolean; available: boolean }>;
  transcribePcm: (
    pcm: ArrayBuffer,
    lang?: 'auto' | 'zh' | 'en',
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  polishAsrText: (
    text: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string; text: string }>;
  auth: AuthApi;
  backendAuth: BackendAuthApi;
  customBackend: CustomBackendApi;
  memory: MemoryApi;
  decisions: {
    open: (path: string) => Promise<{ ok: boolean; error?: string }>;
  };
  documents: DocumentsApi;
  transcripts: TranscriptsApi;
  accessibility: {
    check: () => Promise<{ granted: boolean }>;
    request: () => Promise<{ granted: boolean }>;
  };
  skills: SkillsApi;
  settingsWindow: {
    open: () => Promise<{ ok: boolean }>;
    close: () => Promise<{ ok: boolean }>;
  };
  openCodeEditor: {
    open: (payload: { backendId: string; hostId: string; sessionId: string; cwd: string; title?: string }) => Promise<{ ok: boolean; error?: string }>;
    close: (hostId: string) => Promise<{ ok: boolean; error?: string }>;
    list: () => Promise<{ ok: true; windows: Array<{ hostId: string; backendId: string; sessionId: string; focused: boolean }> } | { ok: false; error: string }>;
  };
  ideFiles: {
    list: (path?: string) => Promise<{ ok: true; entries: FileEntry[] } | { ok: false; error: string }>;
    read: (path: string) => Promise<{ ok: true; file: FileContent } | { ok: false; error: string }>;
  };
  /** Editor-window live panel state. Only exposed by the narrow editor
   *  preload (preload-editor.cjs) — absent from the main window's bridge. */
  ideSession: {
    getState: () => Promise<{ ok: true; state: EditorSnapshot } | { ok: false; error: string }>;
    onEvent: (cb: (msg: { hostId: string; payload: EditorPanelEvent }) => void) => () => void;
  };
  popoutSession: (tabId: string) => Promise<{ ok: boolean }>;
  popoutStage: (windowId: string, type: string) => Promise<{ ok: boolean }>;
  browser: BrowserApi;
  steerWorker: (
    sessionId: string | null,
    workerId: string,
    addendum: string,
  ) => Promise<{ ok: true; queued: boolean } | { ok: false; error: string; reason?: string }>;
  onEvent: (cb: (e: RendererEvent) => void) => () => void;
}

export interface TranscriptsApi {
  load: (
    cwd: string,
  ) => Promise<{ ok: true; entries: TranscriptEntry[] } | { ok: false; error: string }>;
  append: (
    cwd: string,
    entry: TranscriptEntry,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  clear: (cwd: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export type DeliveryFileKind = AttachmentKind | 'pptx' | 'xlsx' | 'video' | 'binary' | 'missing';

export interface DocumentReadOk {
  ok: true;
  path: string;
  name: string;
  sizeBytes: number;
  kind: DeliveryFileKind;
  text?: string;
  truncated?: boolean;
  /** Raw bytes for image/video kinds — main hands these over via structured
   *  clone, so the renderer can wrap them in a Blob and use object URLs
   *  instead of base64 data URLs. */
  data?: Uint8Array;
  /** Legacy base64 payload kept for one transition release. New code should
   *  prefer `data`. */
  dataBase64?: string;
  mediaType?: string;
}

export interface DocumentReadErr {
  ok: false;
  error: string;
  code?: 'not-in-cwd' | 'no-session' | 'missing' | 'too-large' | 'read-failed' | 'invalid-path';
}

export type DocumentReadResult = DocumentReadOk | DocumentReadErr;

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  ext: string;
}

export interface DirListOk {
  ok: true;
  entries: DirEntry[];
}

export interface DirListErr {
  ok: false;
  error: string;
  code?: string;
}

export type DirListResult = DirListOk | DirListErr;

export interface DocumentsApi {
  read: (sessionId: string | null, path: string) => Promise<DocumentReadResult>;
  list: (sessionId: string | null, dirPath: string) => Promise<DirListResult>;
  openExternal: (sessionId: string | null, path: string) => Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    vibeMeet: VibeMeetApi;
  }
}

export interface TranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  ts: number;
  imageUrl?: string;
  attachments?: AttachmentMeta[];
  /** Host group ID for assistant messages — identifies which backend produced this. */
  hostId?: string;
}

export interface ActivityEntry {
  id: string;
  kind: 'tool-call' | 'tool-result' | 'system' | 'error' | 'document';
  title: string;
  detail?: string;
  ts: number;
  source?: AgentSource;
  /** Absolute path to a decision markdown doc; renderer shows an "Open" button when set. */
  actionPath?: string;
}

/** Renderer-side input for the manual Plan Meeting flow. The main process
 * validates the same shape before installing it into the scheduler. */
export interface PlanMeetingTaskInput {
  id: string;
  title: string;
  prompt: string;
  deps: string[];
  executorBackendId?: string;
}

export interface PendingPermission {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
}
