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
  /** File mtime at read time — sent back as expectedMtime on write for
   *  optimistic concurrency. */
  mtimeMs: number;
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

// PTY downlink payloads share the same 'ide-editor:event' channel.
export type PtyDownlink =
  | { kind: 'pty-data'; data: string; encoding: 'utf8' | 'base64' }
  | { kind: 'pty-exit'; exitCode: number | null }
  | { kind: 'pty-error'; error: string };

export type EditorWindowEvent = EditorPanelEvent | PtyDownlink;

export const EDITOR_ACTIVITY_CAP = 200;

// ── IDE registry (Phase 3) ─────────────────────────────────────────────────

export interface EditorCapabilities {
  events: boolean;
  pty: boolean;
  fileWrite: false;
  diff: boolean;
  todo: boolean;
  permissions: boolean;
}

export const NO_EDITOR_CAPABILITIES: EditorCapabilities = {
  events: false,
  pty: false,
  fileWrite: false,
  diff: false,
  todo: false,
  permissions: false,
};

/** Parse the `caps` editor-window query param (mirror of the electron-side
 *  parseEditorCapabilities in ide-adapter.ts). */
export function parseEditorCapabilities(raw: string | null): EditorCapabilities {
  const set = new Set((raw ?? '').split(',').filter(Boolean));
  return {
    events: set.has('events'),
    pty: set.has('pty'),
    fileWrite: false,
    diff: set.has('diff'),
    todo: set.has('todo'),
    permissions: set.has('permissions'),
  };
}

export interface IdeInfo {
  id: string;
  displayName: string;
  description: string;
  installed: boolean;
  version: string | null;
  comingSoon: boolean;
  capabilities?: EditorCapabilities;
}

export interface EditorSceneState {
  hostId: string;
  selectedFile: string | null;
  scrollTop: number;
  updatedAt: number;
}

export interface IdeRegistryState {
  ides: IdeInfo[];
  defaultIdeId: string;
  perHostOverride: Record<string, string>;
}

export type AgentSource = 'talker' | string;

export type WorkerStatus =
  | 'pending'
  | 'running'
  | 'verifying'
  | 'reviewing'
  | 'awaiting-acceptance'
  | 'reworking'
  | 'accepted'
  | 'interrupted'
  | 'done'
  | 'failed';

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
  executorBackendId?: string;
}

export interface MeetingPlan {
  version: number;
  nodes: MeetingPlanNode[];
}

export interface CoordinatorBriefing {
  id: string;
  timestamp: number;
  kind: 'delivery-ready' | 'accepted' | 'failed' | 'stalled' | 'capacity';
  title: string;
  summary: string;
  completedTasks: number;
  failedTasks: number;
  files: number;
  testsPassed: number;
  testsFailed: number;
  blockers: string[];
  recommendedAction: 'continue' | 'review' | 'rework' | 'revise-plan' | 'request-user-decision';
  workerId?: string;
  taskId?: string;
  capacity?: { running: number; limit: number; waiting: number };
}

/** One file delivered by a worker turn. Path is absolute; the renderer
 *  fetches contents via `documents.read`. */
export interface WorkerDeliveryFile {
  path: string;
  snapshotPath?: string;
  /** Legacy recovery field from builds that stored snapshots in the project. */
  snapshotRelativePath?: string;
  sizeBytes?: number;
  sha256?: string;
  previewStatus?: 'copied' | 'too-large' | 'missing' | 'invalid' | 'copy-failed';
}

export interface WorkReport {
  status: 'completed' | 'partial' | 'blocked';
  summary: string;
  files: Array<{ path: string; action: 'created' | 'modified' | 'deleted' }>;
  tests: Array<{
    command: string;
    status: 'passed' | 'failed' | 'not-run';
    summary?: string;
  }>;
  unresolved: Array<{ code: string; message: string; blocking: boolean }>;
}

export type WorkerAdapterSignal =
  | { kind: 'progress'; message: string; percent?: number }
  | { kind: 'tool'; toolName: string; phase: 'started' | 'completed' | 'failed'; detail?: string }
  | { kind: 'delivery'; report: WorkReport }
  | { kind: 'failed'; code: string; message: string; retryable: boolean }
  | { kind: 'ended'; reason: 'completed' | 'interrupted' | 'crashed' };

export interface WorkerEventV2 {
  schemaVersion: 2;
  eventId: string;
  seq: number;
  timestamp: number;
  meetingId: string;
  taskId: string;
  attempt: number;
  workerId: string;
  backendId: string;
  payload: WorkerAdapterSignal;
}

export interface DeliveryView {
  id: string;
  meetingId: string;
  status:
    | 'awaiting-spec-approval'
    | 'preparing-workspace'
    | 'executing'
    | 'verifying'
    | 'reviewing'
    | 'awaiting-delivery-acceptance'
    | 'integrating'
    | 'accepted'
    | 'reworking'
    | 'interrupted'
    | 'failed'
    | 'cancelled';
  spec: {
    version: number;
    objective: string;
    acceptanceCriteria: Array<{
      id: string;
      description: string;
      verification:
        | { kind: 'command'; argv: string[]; timeoutMs?: number }
        | { kind: 'manual' };
    }>;
  };
  sourceRevision: string;
  workspace: string;
  attempt: number;
  attempts: Array<{
    attempt: number;
    report: WorkReport;
    verification?: { passed: boolean; checks: unknown[]; error?: string };
    review?: { passed: boolean; findings: unknown[] };
    outcome:
      | 'reported'
      | 'worker-incomplete'
      | 'verification-failed'
      | 'review-failed'
      | 'awaiting-acceptance'
      | 'returned'
      | 'accepted';
    feedback?: string;
    updatedAt: number;
  }>;
  candidate?: {
    id: string;
    attempt: number;
    report: WorkReport;
    verification: { passed: boolean; checks: unknown[]; error?: string };
    review: { passed: boolean; findings: unknown[] };
  };
  integration?: Record<string, unknown>;
  error?: string;
  updatedAt: number;
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
  | { kind: 'worker-delivery'; workerId: string; title: string; summary: string; taskId: string; deliveryId: string; files: WorkerDeliveryFile[]; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'worker-event'; event: WorkerEventV2; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'delivery-status'; workerId: string; taskId: string; delivery: DeliveryView; source?: AgentSource; sessionId?: string; hostId?: string }
  | { kind: 'coordinator-briefing'; briefing: CoordinatorBriefing; source?: AgentSource; sessionId?: string; hostId?: string }
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
  workerImplementation: boolean;
  workerRuntimeState:
    | 'available'
    | 'needs-install'
    | 'needs-login'
    | 'version-incompatible'
    | 'contract-disabled'
    | 'diagnostic-failed';
  workerRuntimeReason: string;
  version: string | null;
  expectedVersion: string | null;
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
    action: 'continue' | 'retry' | 'abandon',
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
  approvePlan: (
    sessionId: string | null,
    approved: boolean,
    tasks?: PlanMeetingTaskInput[],
  ) => Promise<{ ok: boolean; error?: string }>;
  acceptDelivery: (
    sessionId: string | null,
    deliveryId: string,
    candidateId: string,
  ) => Promise<{ ok: true; delivery: DeliveryView } | { ok: false; error: string }>;
  returnDelivery: (
    sessionId: string | null,
    deliveryId: string,
    candidateId: string | undefined,
    feedback: string,
  ) => Promise<{ ok: true; delivery: DeliveryView } | { ok: false; error: string }>;
  endSession: (sessionId: string | null) => Promise<{ ok: boolean }>;
  pickCwd: () => Promise<string | null>;
  getVoiceConfig: () => Promise<{ enabled: boolean; voicePrint: VoicePrint | null }>;
  setVoiceLockEnabled: (on: boolean) => Promise<{ ok: boolean }>;
  setVoicePrint: (vp: VoicePrint | null) => Promise<{ ok: boolean }>;
  getVoicePref: () => Promise<{ selectedVoiceName: string | null; guidanceDismissed: boolean; speechFilterMode: 'strict' | 'off'; voicePolishEnabled: boolean; reportModeEnabled: boolean; handheldMode: 'auto' | 'handheld' | 'desktop' }>;
  setVoicePref: (patch: { selectedVoiceName?: string | null; guidanceDismissed?: boolean; speechFilterMode?: 'strict' | 'off'; voicePolishEnabled?: boolean; reportModeEnabled?: boolean; handheldMode?: 'auto' | 'handheld' | 'desktop' }) => Promise<{ ok: boolean }>;
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
  deviceDiagnostics: () => Promise<
    | {
        ok: true;
        diagnostics: {
          capturedAt: number;
          platform: string;
          arch: string;
          kernel: string;
          totalMemoryBytes: number;
          electronVersion: string;
          sessionType: string;
          gpu: { available: boolean; status: Record<string, string> };
          audio: {
            microphone: 'granted' | 'denied' | 'available' | 'unavailable' | 'unknown';
            speaker: 'available' | 'unknown';
            whisper: boolean;
          };
          workspace: { git: boolean; worktree: boolean; version: string | null };
          capacity: { hosts: number; workers: number };
        };
      }
    | { ok: false; error: string }
  >;
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
  ideRegistry: {
    list: () => Promise<{ ok: true; state: IdeRegistryState } | { ok: false; error: string }>;
    setDefault: (id: string) => Promise<{ ok: boolean; error?: string }>;
    setOverride: (hostId: string, ideId: string | null) => Promise<{ ok: boolean; error?: string }>;
  };
  ideOverlay: {
    bind: (hostId: string, sessionId: string) => Promise<{ ok: boolean; error?: string }>;
    close: () => Promise<{ ok: boolean; error?: string }>;
    reportScene: (scene: EditorSceneState) => Promise<{ ok: boolean; error?: string }>;
    getScene: (hostId: string) => Promise<{ ok: true; scene: EditorSceneState } | { ok: false; error: string }>;
  };
  onDisplayChanged: (cb: (info: { displayCount: number; added: boolean }) => void) => () => void;
  appVersion: () => Promise<string>;
  onUpdateAvailable: (cb: (info: { latest: string; url: string }) => void) => () => void;
  companion: CompanionApi;
  ideFiles: {
    list: (path?: string) => Promise<{ ok: true; entries: FileEntry[] } | { ok: false; error: string }>;
    read: (path: string) => Promise<{ ok: true; file: FileContent } | { ok: false; error: string }>;
    write: (
      path: string,
      content: string,
      expectedMtime?: number,
    ) => Promise<{ ok: true; file: FileContent } | { ok: false; error: string; conflict?: boolean; currentMtime?: number }>;
  };
  /** PTY terminal (Phase 4). Only on the editor window's narrow preload. */
  idePty: {
    create: () => Promise<{ ok: true; ptyId: string; existing: boolean } | { ok: false; error: string }>;
    input: (data: string) => Promise<{ ok: boolean; error?: string; dropped?: boolean }>;
    resize: (rows: number, cols: number) => Promise<{ ok: boolean; error?: string }>;
    close: () => Promise<{ ok: boolean; error?: string }>;
  };
  /** Editor-window live panel state. Only exposed by the narrow editor
   *  preload (preload-editor.cjs) — absent from the main window's bridge. */
  ideSession: {
    getState: () => Promise<{ ok: true; state: EditorSnapshot } | { ok: false; error: string }>;
    onEvent: (cb: (msg: { hostId: string; payload: EditorWindowEvent }) => void) => () => void;
  };
  popoutSession: (tabId: string) => Promise<{ ok: boolean }>;
  popoutStage: (windowId: string, type: string) => Promise<{ ok: boolean }>;
  browser: BrowserApi;
  steerWorker: (
    sessionId: string | null,
    workerId: string,
    addendum: string,
  ) => Promise<{ ok: true; queued: boolean } | { ok: false; error: string; reason?: string }>;
  interruptWorker: (
    sessionId: string | null,
    workerId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onEvent: (cb: (e: RendererEvent) => void) => () => void;
}

// ── Companion screen (Phase 8) ─────────────────────────────────────────────

export type CompanionStatus = 'idle' | 'working' | 'stalled' | 'celebrating' | 'alert';
export type CompanionAlertLevel = 'none' | 'light' | 'strong';

export interface CompanionBubbleState {
  text: string;
  startedAt: number;
  count: number;
}

export interface CompanionParticipantState {
  hostId: string;
  backendId: string;
  seat: number | 'standing';
  vacated: boolean;
  status: CompanionStatus;
  statusChangedAt: number;
  bubble: CompanionBubbleState | null;
  pendingPermission: boolean;
}

export interface CompanionState {
  participants: CompanionParticipantState[];
  mascot: { text: string; alertLevel: CompanionAlertLevel; coordinatorHostId: string };
  ttsActive: boolean;
}

export interface CompanionApi {
  toggle: () => Promise<{ ok: boolean; open?: boolean; error?: string }>;
  ttsState: (active: boolean) => void;
  /** Companion-window bridge only (preload-companion.cjs). */
  getState?: () => Promise<{ ok: true; state: CompanionState } | { ok: false; error: string }>;
  onEvent?: (cb: (state: CompanionState) => void) => () => void;
  getPrefs?: () => Promise<{ ok: boolean; soundEnabled?: boolean }>;
  setSound?: (soundEnabled: boolean) => Promise<{ ok: boolean; error?: string }>;
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
  writePaths?: string[];
  requiresDecision?: boolean;
  acceptanceCriteria?: Array<{
    id: string;
    description: string;
    verification:
      | { kind: 'command'; argv: string[]; timeoutMs?: number }
      | { kind: 'manual' };
  }>;
}

export interface PendingPermission {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
}
