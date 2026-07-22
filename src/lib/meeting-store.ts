import type {
  ActivityEntry,
  AgentSource,
  AttachmentMeta,
  AutoApproveScope,
  MeetingPlan,
  OpenTabMeta,
  PendingPermission,
  RecentCwdMeta,
  RendererEvent,
  StagedAttachment,
  TranscriptEntry,
  WorkerDeliveryFile,
  WorkerSpecialty,
  WorkerStatus,
  WorkerTaskHistoryEntry,
} from '../types';
import { MEETING_TOOL_NAMES } from '../../electron/meeting-tools';
import { redactSecrets } from '../../electron/format-error';
import { extractText, extractToolUses, uid } from './sdk-message';
import { isSpeechActive, type SpeakHandle } from './speech-session';

const MAX_TRANSCRIPT = 500;
const MAX_ACTIVITY = 500;

// Proactive announcements (progress / blocker) are spoken via short system
// lines so the user is never left waiting in silence when a worker stalls,
// hits a permission prompt, or hands off a delivery. They must never cut the
// talker off mid-sentence, so the queue polls every ANNOUNCE_RETRY_MS and only
// speaks the next line once speech goes idle. The queue is capped — if work
// outpaces speech we drop the oldest lines rather than build a backlog the
// user would hear long after the moment passed.
const ANNOUNCE_RETRY_MS = 350;
const ANNOUNCE_MAX_QUEUE = 6;


function appendCapped<T>(arr: T[], items: T[], max: number): T[] {
  if (items.length === 0) return arr;
  if (arr.length + items.length > max) {
    return arr.slice(arr.length + items.length - max).concat(items);
  }
  return arr.concat(items);
}

const SENTENCE_TERMINATORS = ['。', '！', '？', '!', '?', '\n'];
const COMMA_BREAKS = ['，', ',', '；', ';'];
const STREAM_LONG_BUFFER_THRESHOLD = 80;

/** Carve a "ready" prefix off the streaming buffer, leaving any trailing
 *  partial sentence in `tail` for the next delta. We prefer sentence
 *  terminators (period / 。/ ！/ ？/ newline); for `.` we require the next
 *  character be whitespace, end-of-buffer, or an uppercase letter so we don't
 *  cleave decimals or abbreviations. When the buffer balloons past the
 *  long-buffer threshold without a terminator, fall back to the latest comma
 *  so the user starts hearing audio instead of staring at silence. */
function takeReadySentences(buf: string): { ready: string; tail: string } {
  if (!buf) return { ready: '', tail: '' };
  let lastIdx = -1;
  for (const ch of SENTENCE_TERMINATORS) {
    const i = buf.lastIndexOf(ch);
    if (i > lastIdx) lastIdx = i;
  }
  // '.' followed by a space, end-of-buffer, or uppercase. Match all to find
  // the latest qualifying position so we don't release the buffer prematurely
  // on "v1.0" or "e.g." style strings.
  const dotRe = /\.(?=\s|$|[A-Z])/g;
  let m: RegExpExecArray | null;
  while ((m = dotRe.exec(buf)) !== null) {
    if (m.index > lastIdx) lastIdx = m.index;
  }
  if (lastIdx >= 0) {
    return { ready: buf.slice(0, lastIdx + 1), tail: buf.slice(lastIdx + 1) };
  }
  if (buf.length > STREAM_LONG_BUFFER_THRESHOLD) {
    let commaIdx = -1;
    for (const ch of COMMA_BREAKS) {
      const i = buf.lastIndexOf(ch);
      if (i > commaIdx) commaIdx = i;
    }
    if (commaIdx >= 0) {
      return { ready: buf.slice(0, commaIdx + 1), tail: buf.slice(commaIdx + 1) };
    }
  }
  return { ready: '', tail: buf };
}

/** Pull text out of a partial-message stream_event delta. The Anthropic SDK
 *  shape we care about is `event.delta.text` (content_block_delta with a
 *  text_delta). Anything else (input_json_delta, signature_delta, etc.) is
 *  ignored — those don't represent spoken content. */
function extractStreamDeltaText(streamEvent: unknown): string {
  if (!streamEvent || typeof streamEvent !== 'object') return '';
  const ev = streamEvent as { type?: unknown; delta?: unknown };
  if (ev.type !== 'content_block_delta') return '';
  const delta = ev.delta;
  if (!delta || typeof delta !== 'object') return '';
  const d = delta as { type?: unknown; text?: unknown };
  if (d.type !== 'text_delta') return '';
  return typeof d.text === 'string' ? d.text : '';
}

export interface WorkerState {
  id: AgentSource;
  title: string;
  role: 'talker' | 'worker';
  status: 'idle' | WorkerStatus;
  deps: string[];
  transcript: TranscriptEntry[];
  activity: ActivityEntry[];
  pendingPermission: PendingPermission | null;
  currentTool: string | null;
  currentToolInput: string | null;
  lastText: string;
  endedAt: number | null;
  summary: string;
  specialty: WorkerSpecialty;
  startedAt: number | null;
  taskHistory: WorkerTaskHistoryEntry[];
  /** Host group this worker belongs to. Defaults to 'default'. */
  hostId: string;
}

/** Snapshot of one worker's delivered artifacts, displayed in the ScreenStage
 *  "delivery acceptance" panel. Pushed by a `worker-delivery` event from main
 *  when the worker calls `task_done`. Cleared by the user accepting or by a
 *  new delivery from any worker (only the most recent delivery is staged). */
export type DeliveryStatus = 'pending' | 'accepted' | 'revised';

export interface DeliverySnapshot {
  workerId: AgentSource;
  title: string;
  summary: string;
  taskId: string;
  files: WorkerDeliveryFile[];
  receivedAt: number;
  status: DeliveryStatus;
}

export interface MeetingState {
  workers: Map<AgentSource, WorkerState>;
  plan: MeetingPlan | null;
  running: boolean;
  lastError: string | null;
  /** Most recent delivery awaiting user acceptance. Null when nothing is
   *  staged. Replaced (not queued) when another worker finishes — pick the
   *  freshest one. */
  currentDelivery: DeliverySnapshot | null;
  deliveryHistory: DeliverySnapshot[];
  /** Paths of documents saved via the save_document MCP tool. The renderer
   *  watches this array and auto-opens each new path as a file tab. */
  savedDocuments: string[];
  /** Host groups in this meeting. Always has at least 'default'. Each group
   *  owns one host agent (the "talker" for that group) plus its workers. */
  hostGroups: Map<string, HostGroupState>;
  coordinatorHostId: string;
}

/** One host group: a host agent + its worker pool. Collapsible in the
 *  participant panel — workers hidden by default, click host to expand. */
export interface HostGroupState {
  id: string;
  backendId: string;
  /** Icon identifier for the backend (e.g. 'claude', 'codex', 'kimi', 'qoder').
   *  Used by the participant panel to render per-backend avatars. */
  iconId: string;
  /** The host agent (talker) for this group. */
  hostWorkerId: AgentSource;
  /** Worker ids belonging to this host. */
  workerIds: AgentSource[];
  /** Whether the worker list is collapsed in the UI. Default true. */
  collapsed: boolean;
}

/** Map a backendId to its canonical iconId. Falls back to the backendId itself. */
function iconIdForBackend(backendId: string): string {
  switch (backendId) {
    case 'claude-code': return 'claude';
    case 'codex':       return 'codex';
    case 'kimi':        return 'kimi';
    case 'qoder':       return 'qoder';
    default:            return backendId;
  }
}

/** Tab metadata projected from each slot. Drives the TabStrip rendering. */
export interface TabMeta {
  id: string;
  cwd: string;
  /** placeholder = restored from settings but Orchestrator not yet spawned.
   *  Clicking the tab calls resumePlaceholder() which kicks off sessions:open. */
  placeholder: boolean;
  /** 'starting' = sessions:open returned but session-ready hasn't arrived yet
   *  (SDK subprocess still spawning). User input is buffered in pendingInput
   *  during this state and replayed on ready.
   *  'failed' = session-start-failed landed; user can retry from the tab UI. */
  status: 'idle' | 'running' | 'error' | 'starting' | 'failed';
  unreadCount: number;
  isActive: boolean;
  openedAt: number;
}

/** Buffered user input held while a slot is in 'starting' status. Replayed
 *  in order once 'session-ready' arrives. Dropped silently if the slot fails
 *  before becoming ready (the renderer will show the failed-tab UI instead). */
type PendingInputItem =
  | { kind: 'text'; text: string }
  | { kind: 'image'; dataUrl: string; caption: string }
  | { kind: 'attachments'; staged: StagedAttachment[]; text: string };

/** Returned by getLobbyData() so the Lobby can render Active + Recent without
 *  reaching into store internals. */
export interface LobbyData {
  active: TabMeta[];
  recent: RecentCwdMeta[];
}

interface SlotInternal {
  id: string;                              // sessionId for live slots; `placeholder:<cwd>` for restored-but-not-yet-spawned
  cwd: string;
  placeholder: boolean;
  openedAt: number;
  state: MeetingState;
  unreadCount: number;
  /** Lifecycle of the underlying SDK session.
   *  'starting' → sessions:open returned but session-ready hasn't arrived;
   *  'ready'    → SDK is up, talker input flows directly;
   *  'failed'   → session-start-failed landed; pending buffer is dropped and
   *               the tab shows a retry affordance.
   *  Placeholder slots leave this at 'starting' since they have no live
   *  Orchestrator until resumePlaceholder runs. */
  status: 'starting' | 'ready' | 'failed';
  /** User input that arrived while status !== 'ready'. Replayed in order
   *  when session-ready lands. Dropped on failure. */
  pendingInput: PendingInputItem[];
  // Per-slot scratch
  lastSpoken: string;
  endedSources: Set<AgentSource>;
  intendedExit: boolean;
  greeting: string | undefined;
  /** Flips to true once the on-disk transcript has been spliced in. Until
   *  then, append-persist is suppressed so the load doesn't immediately echo
   *  every restored entry back to disk (it's already there). */
  historyLoaded: boolean;
  /** B3 — talker text that arrived while this slot was NOT active. Replayed
   *  to speakCallback on setActive() if still fresh, so the user doesn't lose
   *  a narration just because they were focused elsewhere when it landed.
   *  Single-entry latching (most recent wins) keeps a long-ignored tab from
   *  dumping a backlog when the user finally clicks in. */
  pendingSpeak: { text: string; ts: number } | null;
  /** Sentence-streaming buffer for the talker. Each `stream_event` delta is
   *  appended to `pendingTail`; whenever a sentence boundary is reached, the
   *  ready prefix is enqueued on the SpeakHandle and the tail keeps growing
   *  for the next sentence. `messageId` doubles as the turnId for the
   *  SpeakHandle so subsequent enqueues recognise the same turn (append) vs.
   *  a different turn (supersede). It also lets the eventual full-assistant
   *  message recognise that streaming already spoke this reply and skip the
   *  one-shot supersede (otherwise the user hears the same text twice).
   *  `hasEmitted` flips on the first emit so we only suppress the duplicate
   *  full-message speak when streaming actually fired — if the SDK emitted
   *  no deltas (flag off), we fall back to the one-shot path.
   *  `cancelledByBarge` flips when the user talks over the AI mid-stream;
   *  subsequent stream events and the eventual full-message supersede are
   *  both suppressed so we don't restart the speech queue after a barge. */
  streamBuffer: {
    messageId: string | null;
    pendingTail: string;
    hasEmitted: boolean;
    cancelledByBarge: boolean;
  };
}

/** B3 — drop a pending replay older than this so a long-backgrounded tab
 *  doesn't blast a stale reply at the user when they switch in. */
const PENDING_SPEAK_TTL_MS = 30_000;

type Listener = () => void;

function createTalkerState(): WorkerState {
  return {
    id: 'talker',
    title: 'Talker',
    role: 'talker',
    status: 'idle',
    deps: [],
    transcript: [],
    activity: [],
    pendingPermission: null,
    currentTool: null,
    currentToolInput: null,
    lastText: '',
    endedAt: null,
    summary: '',
    specialty: 'general',
    startedAt: null,
    taskHistory: [],
    hostId: 'default',
  };
}

function emptyState(defaultBackendId: string = 'claude-code'): MeetingState {
  const workers = new Map<AgentSource, WorkerState>();
  workers.set('talker', createTalkerState());
  const hostGroups = new Map<string, HostGroupState>();
  hostGroups.set('default', {
    id: 'default',
    backendId: defaultBackendId,
    iconId: iconIdForBackend(defaultBackendId),
    hostWorkerId: 'talker',
    workerIds: [],
    collapsed: true,
  });
  return {
    workers,
    plan: null,
    running: false,
    lastError: null,
    currentDelivery: null,
    deliveryHistory: [],
    savedDocuments: [],
    hostGroups,
    coordinatorHostId: 'default',
  };
}

function emptySlot(id: string, cwd: string, defaultBackendId: string = 'claude-code'): SlotInternal {
  return {
    id,
    cwd,
    placeholder: false,
    openedAt: Date.now(),
    state: emptyState(defaultBackendId),
    unreadCount: 0,
    status: 'starting',
    pendingInput: [],
    lastSpoken: '',
    endedSources: new Set(),
    intendedExit: false,
    greeting: undefined,
    historyLoaded: false,
    pendingSpeak: null,
    streamBuffer: { messageId: null, pendingTail: '', hasEmitted: false, cancelledByBarge: false },
  };
}

const PLACEHOLDER_PREFIX = 'placeholder:';
function placeholderId(cwd: string): string {
  return `${PLACEHOLDER_PREFIX}${cwd}`;
}

class MeetingStore {
  private slots = new Map<string, SlotInternal>();
  private activeId: string | null = null;
  private recentCwds: RecentCwdMeta[] = [];
  private restoreHydrated = false;
  /** User's preferred default backend for new sessions (set from Lobby). */
  defaultBackendId: string | null = null;
  /** Sticky empty state returned by getSnapshot() when no slot is active.
   *  Held as a stable reference so useSyncExternalStore's identity check
   *  doesn't fire spurious renders. */
  private readonly EMPTY: MeetingState = emptyState();
  /** Cached tab projection. Recomputed on demand and invalidated on every
   *  slot mutation. Required so useSyncExternalStore receives a stable
   *  reference across renders — otherwise React tear-loops. */
  private cachedTabs: TabMeta[] | null = null;
  /** activeCwd cache uses a separate "fresh" flag because null is a valid value
   *  (no active slot). */
  private cachedActiveCwd: string | null = null;
  private cachedActiveCwdFresh = false;
  /** Lobby projection cache. Invalidated whenever tabs or recents change. */
  private cachedLobbyData: LobbyData | null = null;

  private listeners = new Set<Listener>();
  private tabListeners = new Set<Listener>();
  /** Unified TTS sink. supersede() replaces in-flight playback (one-shot);
   *  enqueue(text, turnId) appends to a streaming turn (or supersedes if no
   *  active session matches turnId); markTurnComplete(turnId) signals the end
   *  of a streaming turn so the queue can drain its onAllDone. The renderer
   *  wires all three; meeting-store calls whichever matches the event source. */
  private speakCallback: SpeakHandle | null = null;
  private subscribed = false;
  private unsubscribeEvents: (() => void) | null = null;

  // Proactive-announcement queue (see ANNOUNCE_* constants). Mirrors the
  // trust-mode scope pushed down from App so we can stay quiet about
  // permission prompts that auto-approve already resolves.
  private announceQueue: string[] = [];
  private announceTimer: number | null = null;
  private autoApproveScope: AutoApproveScope = 'off';

  /** Update the default host group's backendId when the renderer learns which
   *  backend is the user's default. Called from App after backends are loaded. */
  syncDefaultBackend(backendId: string) {
    this.defaultBackendId = backendId;
    if (!this.activeId) return;
    const slot = this.slots.get(this.activeId);
    if (!slot) return;
    const hg = slot.state.hostGroups.get('default');
    if (!hg || hg.backendId === backendId) return;
    this.mutateSlot(this.activeId, (s) => {
      const hostGroups = new Map(s.hostGroups);
      hostGroups.set('default', {
        ...hg,
        backendId,
        iconId: iconIdForBackend(backendId),
      });
      return { ...s, hostGroups };
    });
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.ensureSubscribed();
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): MeetingState => {
    const slot = this.activeId ? this.slots.get(this.activeId) : null;
    return slot ? slot.state : this.EMPTY;
  };

  subscribeTabs = (listener: Listener): (() => void) => {
    this.tabListeners.add(listener);
    this.ensureSubscribed();
    return () => { this.tabListeners.delete(listener); };
  };

  getTabs = (): TabMeta[] => {
    if (this.cachedTabs) return this.cachedTabs;
    const tabs: TabMeta[] = [];
    for (const slot of this.slots.values()) {
      // Status precedence (most informative wins):
      //   placeholder (not yet spawned)         → idle
      //   starting   (SDK still spawning)       → starting
      //   failed     (start failed)             → failed
      //   lastError  (mid-session error)        → error
      //   running    (talker actively working)  → running
      //   else                                  → idle
      const status: TabMeta['status'] = slot.placeholder
        ? 'idle'
        : slot.status === 'starting'
          ? 'starting'
          : slot.status === 'failed'
            ? 'failed'
            : slot.state.lastError
              ? 'error'
              : slot.state.running
                ? 'running'
                : 'idle';
      tabs.push({
        id: slot.id,
        cwd: slot.cwd,
        placeholder: slot.placeholder,
        status,
        unreadCount: slot.unreadCount,
        isActive: slot.id === this.activeId,
        openedAt: slot.openedAt,
      });
    }
    // Stable order: by openedAt ascending so tabs don't reshuffle on focus.
    tabs.sort((a, b) => a.openedAt - b.openedAt);
    this.cachedTabs = tabs;
    return tabs;
  };

  getActiveId = (): string | null => this.activeId;

  getActiveCwd = (): string | null => {
    // Cached so useSyncExternalStore sees a stable reference across renders
    // until something actually changes (invalidated in invalidateTabCache()).
    if (this.cachedActiveCwdFresh) return this.cachedActiveCwd;
    const slot = this.activeId ? this.slots.get(this.activeId) : null;
    this.cachedActiveCwd = slot ? slot.cwd : null;
    this.cachedActiveCwdFresh = true;
    return this.cachedActiveCwd;
  };

  private invalidateTabCache() {
    this.cachedTabs = null;
    this.cachedActiveCwdFresh = false;
    this.cachedLobbyData = null;
  }

  /** Returns whichever sessionId we should pass to main for active-tab calls.
   *  Placeholder slots have no Orchestrator yet, so we never forward their id. */
  private effectiveSessionId(): string | null {
    if (!this.activeId) return null;
    const slot = this.slots.get(this.activeId);
    if (!slot || slot.placeholder) return null;
    return slot.id;
  }

  getLobbyData = (): LobbyData => {
    if (this.cachedLobbyData) return this.cachedLobbyData;
    this.cachedLobbyData = {
      active: this.getTabs(),
      recent: this.recentCwds,
    };
    return this.cachedLobbyData;
  };

  setSpeakCallback(cb: SpeakHandle | null) {
    this.speakCallback = cb;
  }

  /** App mirrors the trust-mode scope here so blocker announcements can stay
   *  quiet when auto-approve will resolve the prompt itself. */
  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
  }

  /** Queue a short spoken status line for the user. No-op when TTS is off
   *  (speakCallback null). The line is spoken once speech goes idle so it
   *  never cuts the talker off mid-sentence. */
  private announce(text: string) {
    const line = text.trim();
    if (!line || !this.speakCallback) return;
    this.announceQueue.push(line);
    if (this.announceQueue.length > ANNOUNCE_MAX_QUEUE) {
      this.announceQueue.splice(0, this.announceQueue.length - ANNOUNCE_MAX_QUEUE);
    }
    this.tryFlushAnnounce();
  }

  /** Drain one queued announcement when nothing is speaking, then poll back
   *  for the next. Polling (rather than chaining on the supersede onDone) keeps
   *  the queue draining even when the talker silently cancels an in-flight
   *  announcement by starting a new turn. Self-terminates once the queue empties. */
  private tryFlushAnnounce() {
    if (!this.speakCallback) {
      this.announceQueue = [];
      this.clearAnnounceTimer();
      return;
    }
    if (this.announceQueue.length === 0) {
      this.clearAnnounceTimer();
      return;
    }
    if (isSpeechActive()) {
      this.scheduleAnnounceRetry();
      return;
    }
    const line = this.announceQueue.shift();
    if (line) {
      try { this.speakCallback.supersede(line); } catch (err) {
        console.warn('[meeting-store] announce supersede threw:', err);
      }
    }
    // Come back after this line starts playing to drain the rest.
    this.scheduleAnnounceRetry();
  }

  private scheduleAnnounceRetry() {
    if (this.announceTimer !== null) return;
    this.announceTimer = window.setTimeout(() => {
      this.announceTimer = null;
      this.tryFlushAnnounce();
    }, ANNOUNCE_RETRY_MS);
  }

  private clearAnnounceTimer() {
    if (this.announceTimer !== null) {
      window.clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
  }

  /** VAD detected the user talking over the AI. Tag the active turn so any
   *  in-flight stream events (and the eventual full-message terminal) are
   *  suppressed — without this, the cancelled queue would restart on the
   *  next delta or supersede on full-message arrival. The renderer is
   *  responsible for the actual cancelSpeech() call; this only updates the
   *  dedup state. */
  markBargeIn(): void {
    // User took the floor — drop any pending status announcements so we don't
    // talk over them the instant they finish speaking.
    this.announceQueue = [];
    this.clearAnnounceTimer();
    const slot = this.activeId ? this.slots.get(this.activeId) : null;
    if (!slot) return;
    slot.streamBuffer.cancelledByBarge = true;
  }

  private ensureSubscribed() {
    if (this.subscribed) return;
    this.subscribed = true;
    this.unsubscribeEvents = window.vibeMeet.onEvent((e) => this.handleIncomingEvent(e));
  }

  /** B4 — explicit teardown for the IPC event subscription. The singleton
   *  normally holds this for the whole renderer lifetime (which is fine —
   *  one listener, no accumulation), but tests and secondary renderers can
   *  call dispose() to detach cleanly. */
  dispose(): void {
    if (this.unsubscribeEvents) {
      try { this.unsubscribeEvents(); } catch (err) {
        console.warn('[meeting-store] unsubscribeEvents threw', err);
      }
      this.unsubscribeEvents = null;
    }
    // C2: the announce retry timer holds a window.setTimeout handle; without
    // this a dispose() mid-retry leaks the timer (and would fire into a
    // torn-down store).
    this.announceQueue = [];
    this.clearAnnounceTimer();
    this.subscribed = false;
  }

  private notify(slotId: string) {
    this.invalidateTabCache();
    if (slotId === this.activeId) {
      for (const l of this.listeners) {
        try { l(); } catch { /* one bad listener must not block others */ }
      }
    }
    // Tab status / unread badge can change for any slot, so always nudge tab
    // listeners. Cheap (just badges).
    for (const l of this.tabListeners) {
      try { l(); } catch { /* one bad listener must not block others */ }
    }
  }

  private notifyTabsOnly() {
    this.invalidateTabCache();
    for (const l of this.tabListeners) {
      try { l(); } catch { /* one bad listener must not block others */ }
    }
  }

  private mutateSlot(slotId: string, updater: (s: MeetingState) => MeetingState) {
    const slot = this.slots.get(slotId);
    if (!slot) return;
    slot.state = updater(slot.state);
    this.notify(slotId);
  }

  // --- Transcript persistence ----------------------------------------------

  /** Mirror a newly-appended talker transcript entry to the on-disk JSONL.
   *  Suppressed before historyLoaded flips so the freshly-loaded restore
   *  doesn't double-write. Placeholder slots have no live session and never
   *  emit entries, but we still guard defensively. */
  private persistTalkerEntry(slot: SlotInternal, entry: TranscriptEntry): void {
    if (!slot.historyLoaded || slot.placeholder) return;
    void window.vibeMeet.transcripts.append(slot.cwd, entry).catch((err: unknown) => {
      console.warn('[meeting-store] transcript append failed:', err);
    });
  }

  /** Splice restored entries into the slot's talker transcript on first
   *  open / placeholder promotion. Always sets historyLoaded=true (even on
   *  error) so subsequent appends start persisting. */
  private async loadHistoryForSlot(slot: SlotInternal): Promise<void> {
    // Entries that landed in the in-memory transcript during this async load
    // window were suppressed by persistTalkerEntry (historyLoaded still false),
    // so they live only in memory and vanish on restart. Capture the pre-merge
    // window entries here and flush them once the gate flips. Restored history
    // is never in this list, so there is no double-write.
    let pendingFlush: TranscriptEntry[] | null = null;
    try {
      const r = await window.vibeMeet.transcripts.load(slot.cwd);
      if (r.ok && r.entries.length > 0) {
        const restored = r.entries.slice(-MAX_TRANSCRIPT);
        this.mutateSlot(slot.id, (s) => {
          const workers = new Map(s.workers);
          const talker = workers.get('talker') ?? createTalkerState();
          // Prepend restored; the slot is fresh so existing transcript is
          // typically empty, but if any events landed between slot insert
          // and load resolve we keep them after the restored history.
          pendingFlush = talker.transcript;
          const merged = [...restored, ...talker.transcript].slice(-MAX_TRANSCRIPT);
          workers.set('talker', { ...talker, transcript: merged });
          return { ...s, workers };
        });
      } else if (!r.ok) {
        console.warn('[meeting-store] transcript load failed:', r.error);
      }
    } catch (err) {
      console.warn('[meeting-store] transcript load threw:', err);
    } finally {
      slot.historyLoaded = true;
      // No merge happened (no history / error): the in-memory transcript holds
      // only window entries, so flush all of them.
      if (pendingFlush === null) {
        pendingFlush = this.slots.get(slot.id)?.state.workers.get('talker')?.transcript ?? [];
      }
      for (const entry of pendingFlush) this.persistTalkerEntry(slot, entry);
    }
  }

  /** Build a greeting that includes resume context from the transcript.
   *  Loads the on-disk transcript for `cwd` and, if there's history, appends
   *  a summary of the last few exchanges so the AI can pick up where it
   *  left off instead of starting cold. */
  private async buildResumeGreeting(cwd: string, baseGreeting: string): Promise<string> {
    try {
      const r = await window.vibeMeet.transcripts.load(cwd);
      if (!r.ok || r.entries.length === 0) return baseGreeting;
      // Take the last 8 entries (4 exchanges) for context — enough to
      // understand what was happening without overwhelming the prompt.
      const recent = r.entries.slice(-8);
      const summary = recent
        .map((e) => `${e.role === 'user' ? 'User' : 'Assistant'}: ${e.text.slice(0, 200)}`)
        .join('\n');
      return `${baseGreeting}\n\n[RESUME CONTEXT — Previous conversation in this project:]\n${summary}\n\nIf the user was working on something, acknowledge it and ask if they want to continue or start fresh. Keep your greeting warm and brief.`;
    } catch (err) {
      console.warn('[meeting-store] buildResumeGreeting failed:', err);
      return baseGreeting;
    }
  }

  // --- Slot lifecycle -------------------------------------------------------

  async hydrateRestore(): Promise<void> {
    if (this.restoreHydrated) return;
    this.restoreHydrated = true;
    try {
      const res = await window.vibeMeet.sessions.listRestore();
      if (!res.ok) return;
      this.recentCwds = res.recentCwds ?? [];
      const tabs: OpenTabMeta[] = res.openTabs ?? [];
      for (const t of tabs) {
        if (this.findByCwd(t.cwd)) continue;
        const slot: SlotInternal = {
          ...emptySlot(placeholderId(t.cwd), t.cwd),
          placeholder: true,
          openedAt: t.openedAt,
        };
        this.slots.set(slot.id, slot);
      }
      // Pick an initial active placeholder so the UI knows which tab is
      // selected on cold start — even though no Orchestrator is spawned yet.
      if (!this.activeId && res.lastActiveCwd) {
        const target = this.findByCwd(res.lastActiveCwd);
        if (target) this.activeId = target.id;
      }
      if (!this.activeId) {
        const first = [...this.slots.values()][0];
        if (first) this.activeId = first.id;
      }
      this.notifyTabsOnly();
    } catch (err) {
      console.error('[meeting-store] hydrateRestore failed', err);
    }
  }

  private findByCwd(cwd: string): SlotInternal | null {
    for (const s of this.slots.values()) {
      if (s.cwd === cwd) return s;
    }
    return null;
  }

  async openSession(
    cwd: string,
    greeting?: string,
    recoveryMeetingId?: string,
  ): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    // Transport readiness must not spend a model turn. Startup greetings can
    // queue ahead of real user input and surface much later as an unrelated
    // "welcome back" response. The empty chat state shows readiness locally.
    let effectiveGreeting = recoveryMeetingId ? '' : (greeting ?? '');
    // If a placeholder already exists for this cwd, resume it instead of
    // creating a second tab. Mirrors main-side cwd uniqueness.
    const existing = this.findByCwd(cwd);
    if (existing && existing.placeholder) {
      return this.resumePlaceholder(existing.id, effectiveGreeting);
    }
    if (existing && !existing.placeholder) {
      // Already open — just focus it. Matches main-side duplicate handling.
      await this.setActive(existing.id);
      return { ok: true, sessionId: existing.id };
    }
    // Pre-load transcript to inject resume context if there's history.
    // This gives the AI awareness of the previous conversation so it can
    // continue tasks instead of starting cold each time.
    if (!recoveryMeetingId && effectiveGreeting) {
      effectiveGreeting = await this.buildResumeGreeting(cwd, effectiveGreeting);
    }

    const res = await window.vibeMeet.sessions.open(
      cwd,
      effectiveGreeting,
      this.defaultBackendId ?? undefined,
      recoveryMeetingId,
    );
    if (!res.ok) {
      if (res.error === 'duplicate' && 'sessionId' in res && res.sessionId) {
        await this.setActive(res.sessionId);
        return { ok: true, sessionId: res.sessionId };
      }
      return { ok: false, error: res.error };
    }
    const slot = emptySlot(res.sessionId, res.cwd, res.backendId ?? this.defaultBackendId ?? 'claude-code');
    slot.greeting = effectiveGreeting;
    slot.state = { ...slot.state, running: true };
    this.slots.set(res.sessionId, slot);
    this.activeId = res.sessionId;
    // Update local recents optimistically so the Lobby reflects the new pick
    // even before next listRestore. Main writes the canonical copy.
    this.recentCwds = [
      { path: res.cwd, lastOpenedAt: Date.now() },
      ...this.recentCwds.filter((r) => r.path !== res.cwd),
    ].slice(0, 10);
    this.notifyTabsOnly();
    this.notify(res.sessionId);
    void this.loadHistoryForSlot(slot);
    return { ok: true, sessionId: res.sessionId };
  }

  async resumePlaceholder(placeholderSlotId: string, greeting?: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const ph = this.slots.get(placeholderSlotId);
    if (!ph || !ph.placeholder) return { ok: false, error: 'not-placeholder' };
    // Pre-load transcript to inject resume context if there's history.
    let effectiveGreeting = greeting ?? '';
    if (effectiveGreeting) effectiveGreeting = await this.buildResumeGreeting(ph.cwd, effectiveGreeting);

    const res = await window.vibeMeet.sessions.open(ph.cwd, effectiveGreeting, this.defaultBackendId ?? undefined);
    if (!res.ok) {
      if (res.error === 'duplicate' && 'sessionId' in res && res.sessionId) {
        // Race: another tab already opened it. Drop our placeholder and focus
        // the winner.
        this.slots.delete(placeholderSlotId);
        this.activeId = res.sessionId;
        this.notifyTabsOnly();
        return { ok: true, sessionId: res.sessionId };
      }
      return { ok: false, error: res.error };
    }
    // Promote placeholder → live slot. Preserve openedAt so tab position is
    // stable across the resume.
    const promoted = emptySlot(res.sessionId, res.cwd, this.defaultBackendId ?? 'claude-code');
    promoted.openedAt = ph.openedAt;
    promoted.greeting = effectiveGreeting;
    promoted.state = { ...promoted.state, running: true };
    this.slots.delete(placeholderSlotId);
    this.slots.set(res.sessionId, promoted);
    this.activeId = res.sessionId;
    this.notifyTabsOnly();
    this.notify(res.sessionId);
    void this.loadHistoryForSlot(promoted);
    return { ok: true, sessionId: res.sessionId };
  }

  async setActive(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    // Switch main first, then flip local activeId. If we set activeId
    // synchronously and then await the IPC, any event main emits between the
    // local switch and the main-process switch lands in the wrong slot
    // (renderer's activeId already pointing at the new id while main still
    // routes its events to the old one, or vice-versa). Bail without
    // switching when the IPC fails so we don't desync.
    if (!slot.placeholder) {
      try {
        const res = await window.vibeMeet.sessions.setActive(id);
        if (!res || res.ok === false) {
          console.warn('[meeting-store] setActive IPC failed, not switching local active', { id, res });
          return;
        }
      } catch (err) {
        console.warn('[meeting-store] setActive IPC threw, not switching local active', { id, err });
        return;
      }
    }
    // C1: status announcements queued for the slot we're leaving must not
    // play after the switch — they'd describe the wrong meeting. Drop them
    // (and the pending retry timer) on every context flip.
    this.announceQueue = [];
    this.clearAnnounceTimer();
    this.activeId = id;
    slot.unreadCount = 0;
    // B3: replay the freshest backgrounded talker text on switch-in so the
    // user hears what landed while focused elsewhere. Stale (>TTL) replays
    // are dropped to avoid an avalanche when re-opening an idle tab.
    const pending = slot.pendingSpeak;
    slot.pendingSpeak = null;
    if (
      pending &&
      Date.now() - pending.ts <= PENDING_SPEAK_TTL_MS &&
      pending.text !== slot.lastSpoken &&
      this.speakCallback
    ) {
      slot.lastSpoken = pending.text;
      try { this.speakCallback.supersede(pending.text); } catch (err) {
        console.warn('[meeting-store] pendingSpeak replay threw', err);
      }
    }
    this.notifyTabsOnly();
    this.notify(id);
  }

  async closeTab(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (!slot.placeholder) {
      try { await window.vibeMeet.sessions.close(id); } catch (err) {
        console.warn('[meeting-store] sessions.close (closeTab) failed', { id, err });
      }
    }
    this.slots.delete(id);
    if (this.activeId === id) {
      const next = [...this.slots.values()].sort((a, b) => b.openedAt - a.openedAt)[0];
      this.activeId = next ? next.id : null;
    }
    // Reflect closure into recents so the Lobby shows the just-closed cwd
    // near the top. Main writes the canonical copy via sessions:close.
    if (!this.findByCwd(slot.cwd)) {
      this.recentCwds = [
        { path: slot.cwd, lastOpenedAt: Date.now() },
        ...this.recentCwds.filter((r) => r.path !== slot.cwd),
      ].slice(0, 10);
    }
    this.notifyTabsOnly();
    if (this.activeId) this.notify(this.activeId);
    else for (const l of this.listeners) { try { l(); } catch { /* listener error */ } }
  }

  // --- Event routing --------------------------------------------------------

  private handleIncomingEvent(e: RendererEvent) {
    // sessionId is always present on events from the multi-tab main; older
    // unsourced events (defensive only) get dropped silently because we can't
    // route them. We also let the active slot absorb sessionId-less events if
    // it's the only live one — but most callsites in main now tag every
    // emit, so the fallback is rare.
    const sessionId = (e as { sessionId?: string }).sessionId;
    let targetId: string | null = sessionId ?? null;
    if (!targetId) {
      // Fallback: deliver to active slot if it's a live (non-placeholder) one.
      const active = this.activeId ? this.slots.get(this.activeId) : null;
      if (active && !active.placeholder) targetId = active.id;
    }
    if (!targetId) return;
    const slot = this.slots.get(targetId);
    if (!slot || slot.placeholder) return;
    this.handleEventForSlot(slot, e);
  }

  private bumpUnread(slot: SlotInternal) {
    if (slot.id === this.activeId) return;
    slot.unreadCount += 1;
  }

  private handleEventForSlot(slot: SlotInternal, e: RendererEvent) {
    const source: AgentSource = e.source ?? 'talker';
    if (e.kind === 'session-ready') {
      slot.status = 'ready';
      // For non-default hosts, create a talker WorkerState so the participant
      // panel shows the host as active instead of stuck at "Connecting…".
      const hostId = e.hostId ?? 'default';
      if (hostId !== 'default') {
        const talkerKey = `talker:${hostId}`;
        this.mutateSlot(slot.id, (s) => {
          const workers = new Map(s.workers);
          if (!workers.has(talkerKey)) {
            workers.set(talkerKey, {
              ...createTalkerState(),
              id: 'talker',
              hostId,
              status: 'running',
            });
          }
          return { ...s, workers, running: true, lastError: null };
        });
      } else {
        this.mutateSlot(slot.id, (s) => {
          const workers = new Map(s.workers);
          const talker = workers.get('talker');
          if (talker) workers.set('talker', { ...talker, status: 'running', endedAt: null });
          return { ...s, workers, running: true, lastError: null };
        });
      }
      const pending = slot.pendingInput;
      slot.pendingInput = [];
      if (pending.length > 0) {
        // Send directly to this slot's session via explicit ID — NOT through
        // activeLiveSlot() which would route to whichever tab is active now.
        const targetId = slot.id;
        void (async () => {
          try {
            for (const item of pending) {
              try {
                if (item.kind === 'text') {
                  await window.vibeMeet.sendUserText(targetId, item.text);
                } else if (item.kind === 'image') {
                  await window.vibeMeet.sendUserImage(targetId, item.dataUrl, item.caption);
                } else if (item.kind === 'attachments') {
                  const wire = item.staged.map((a) => ({
                    name: a.name,
                    mime: a.mime,
                    sizeBytes: a.sizeBytes,
                    dataBase64: a.dataBase64,
                  }));
                  await window.vibeMeet.sendUserAttachments(targetId, wire, item.text);
                }
              } catch (err) {
                console.warn('[meeting-store] pendingInput replay threw', err);
              }
            }
          } catch (err) {
            console.error('[meeting-store] pendingInput IIFE failed', err);
          }
        })();
      }
      return;
    }
    if (e.kind === 'session-start-failed') {
      slot.status = 'failed';
      slot.pendingInput = [];
      this.mutateSlot(slot.id, (s) => ({ ...s, running: false, lastError: e.error }));
      return;
    }
    if (e.kind === 'worker-spawned') {
      const hostId = e.hostId ?? 'default';
      this.mutateSlot(slot.id, (s) => {
        const workers = new Map(s.workers);
        const existing = workers.get(e.workerId);
        const now = Date.now();
        const isReassign = !!(existing && existing.endedAt !== null);
        const archivedHistory: WorkerTaskHistoryEntry[] = isReassign
          ? [
              ...existing!.taskHistory,
              {
                id: `${e.workerId}-task-${existing!.taskHistory.length + 1}`,
                title: existing!.title,
                status: existing!.status === 'idle' ? 'done' : existing!.status,
                startedAt: existing!.startedAt ?? existing!.endedAt!,
                finishedAt: existing!.endedAt!,
                summary: existing!.summary || undefined,
              },
            ]
          : existing?.taskHistory ?? [];
        const next: WorkerState = existing
          ? {
              ...existing,
              title: e.title,
              deps: e.deps,
              status: 'running',
              specialty: e.specialty,
              startedAt: now,
              endedAt: null,
              summary: '',
              currentTool: null,
              currentToolInput: null,
              pendingPermission: null,
              lastText: '',
              activity: isReassign ? [] : existing.activity,
              transcript: isReassign ? [] : existing.transcript,
              taskHistory: archivedHistory,
              hostId,
            }
          : {
              id: e.workerId,
              title: e.title,
              role: 'worker',
              status: 'running',
              deps: e.deps,
              transcript: [],
              activity: [],
              pendingPermission: null,
              currentTool: null,
              currentToolInput: null,
              lastText: '',
              endedAt: null,
              summary: '',
              specialty: e.specialty,
              startedAt: now,
              taskHistory: [],
              hostId,
            };
        workers.set(e.workerId, next);

        // Update HostGroupState: add worker to its host group.
        const hostGroups = new Map(s.hostGroups);
        const hg = hostGroups.get(hostId);
        if (hg) {
          const ids = hg.workerIds.includes(e.workerId)
            ? hg.workerIds
            : [...hg.workerIds, e.workerId];
          hostGroups.set(hostId, { ...hg, workerIds: ids });
        } else {
          // New host group — create it with this worker.
          hostGroups.set(hostId, {
            id: hostId,
            backendId: hostId, // Will be updated when host info arrives
            iconId: iconIdForBackend(hostId),
            hostWorkerId: `host-${hostId}`,
            workerIds: [e.workerId],
            collapsed: true,
          });
        }

        return { ...s, workers, hostGroups };
      });
      return;
    }
    if (e.kind === 'worker-ended') {
      this.updateWorker(slot, e.workerId, (w) => ({
        ...w,
        status: e.status,
        endedAt: Date.now(),
        summary: e.summary ?? w.summary,
        currentTool: null,
        currentToolInput: null,
      }));
      // A failure is a blocker the user needs to hear — done workers are
      // covered by the louder worker-delivery announcement instead.
      if (slot.id === this.activeId && e.status === 'failed') {
        const name = this.workerLabel(slot, e.workerId);
        this.announce(`「${name}」失败了${e.summary ? '：' + e.summary : '，需要你看一下'}`);
      }
      return;
    }
    if (e.kind === 'worker-stalled') {
      // B1: the worker has gone quiet for a long stretch while still running
      // (hung tool, invisible native dialog, loop). Speak it so the user
      // isn't left waiting blind. One event per idle stretch (main dedupes).
      this.bumpUnread(slot);
      if (slot.id === this.activeId) {
        const secs = Math.round(e.idleMs / 1000);
        const toolPart = e.currentTool ? `卡在 ${e.currentTool} 上` : '没有进展';
        this.announce(`「${e.title}」已经 ${secs} 秒${toolPart}了，可能需要你看一下`);
      }
      return;
    }
    if (e.kind === 'worker-delivery') {
      const snapshot: DeliverySnapshot = {
        workerId: e.workerId,
        title: e.title,
        summary: e.summary,
        taskId: e.taskId,
        files: e.files,
        receivedAt: Date.now(),
        status: 'pending',
      };
      const MAX_DELIVERY_HISTORY = 20;
      this.mutateSlot(slot.id, (s) => ({
        ...s,
        currentDelivery: snapshot,
        deliveryHistory: [...s.deliveryHistory, snapshot].slice(-MAX_DELIVERY_HISTORY),
      }));
      this.bumpUnread(slot);
      return;
    }
    if (e.kind === 'plan-updated') {
      this.mutateSlot(slot.id, (s) => ({ ...s, plan: e.plan }));
      return;
    }
    if (e.kind === 'plan-proposed') {
      const summary = e.tasks
        .map((task) => `• ${task.title} → ${task.executorBackendId ?? 'coordinator backend'}`)
        .join('\n');
      const approved = window.confirm(`Host 提议了 ${e.tasks.length} 个任务：\n\n${summary}\n\n是否启动这些 Worker？`);
      void window.vibeMeet.approvePlan(slot.id, approved).then((result) => {
        if (!result.ok) {
          this.mutateSlot(slot.id, (s) => ({ ...s, lastError: result.error ?? 'Plan approval failed' }));
        }
      });
      return;
    }
    if (e.kind === 'auth-required') {
      this.updateWorker(slot, source, (w) => ({
        ...w,
        status: 'idle',
        endedAt: Date.now(),
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: '需要重新登录', detail: e.error, ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }), e.hostId);
      this.mutateSlot(slot.id, (s) => ({ ...s, running: false, lastError: e.error }));
      this.bumpUnread(slot);
      return;
    }
    if (e.kind === 'error') {
      this.updateWorker(slot, source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: 'Error', detail: e.error, ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }), e.hostId);
      this.mutateSlot(slot.id, (s) => ({ ...s, lastError: e.error }));
      this.bumpUnread(slot);
      return;
    }
    if (e.kind === 'ended') {
      slot.endedSources.add(source);
      this.updateWorker(slot, source, (w) => ({
        ...w,
        status: w.status === 'idle' || w.role === 'talker' ? 'idle' : (w.status === 'running' ? 'done' : w.status),
        endedAt: Date.now(),
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: `${source} ended`, ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }), e.hostId);
      return;
    }
    if (e.kind === 'coordinator-failed') {
      if (!e.candidateHostId) {
        this.mutateSlot(slot.id, (s) => ({ ...s, running: false, lastError: e.error ?? 'Coordinator exited and no replacement is ready.' }));
        return;
      }
      const approved = window.confirm(`当前主持人 ${e.hostId} 已退出。是否由 ${e.candidateHostId} 接管？\n\n已有 Worker 会继续运行。`);
      if (approved) {
        void this.setCoordinator(e.candidateHostId);
      } else {
        this.mutateSlot(slot.id, (s) => ({ ...s, lastError: '新任务调度已暂停，等待选择主持人。' }));
      }
      return;
    }
    if (e.kind === 'permission-request') {
      this.updateWorker(slot, source, (w) => ({
        ...w,
        pendingPermission: { id: e.id, toolName: e.toolName, input: e.input, toolUseID: e.toolUseID },
        activity: appendCapped(
          w.activity,
          [{
            id: uid(),
            kind: 'tool-call',
            title: `Permission asked: ${e.toolName}`,
            detail: JSON.stringify(e.input).slice(0, 200),
            ts: Date.now(),
            source,
          }],
          MAX_ACTIVITY,
        ),
      }), e.hostId);
      this.bumpUnread(slot);
      // The whole point of the feature: don't leave the user waiting in
      // silence when an agent is blocked on a confirmation. A permission-request
      // only reaches the renderer when it genuinely needs the user (scope 'off',
      // or the degraded 'read' path with no native confirmer) — 'all' never
      // emits one. So announce whenever it arrives, except under 'all'.
      if (slot.id === this.activeId && this.autoApproveScope !== 'all') {
        const name = this.workerLabel(slot, source, e.hostId);
        this.announce(`${name}卡住了，需要你确认是否允许 ${e.toolName}`);
      }
      return;
    }
    if (e.kind === 'permission-cancelled') {
      // Withdraw the approval card when the request was resolved elsewhere:
      // permission.replied from any end, broker fail-closed timeout, or
      // session teardown (PermissionBroker auto-reject).
      this.updateWorker(slot, source, (w) => (
        w.pendingPermission?.id === e.id ? { ...w, pendingPermission: null } : w
      ), e.hostId);
      return;
    }
    if (e.kind === 'decision-pending') {
      const sideChannels = [
        e.calendarOk ? '日历' : null,
        e.remindersOk ? '提醒' : null,
      ].filter(Boolean);
      const sideNote = sideChannels.length > 0
        ? ` · 已发到${sideChannels.join('/')}`
        : '';
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{
            id: uid(),
            kind: 'system',
            title: `等你确认：${e.question}`,
            detail: `推荐方案：${e.recommendedTitle}${sideNote}`,
            ts: Date.now(),
            source: 'talker',
            actionPath: e.path,
          }],
          MAX_ACTIVITY,
        ),
      }), e.hostId);
      this.bumpUnread(slot);
      if (slot.id === this.activeId) {
        this.announce(`等你确认：${e.question}`);
      }
      return;
    }
    if (e.kind === 'decision-resolved') {
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{
            id: uid(),
            kind: 'system',
            title: `用户已确认：${e.question}`,
            detail: e.conclusion,
            ts: Date.now(),
            source: 'talker',
            actionPath: e.path,
          }],
          MAX_ACTIVITY,
        ),
      }), e.hostId);
      return;
    }
    if (e.kind === 'document-saved') {
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{
            id: uid(),
            kind: 'document',
            title: e.title,
            detail: `文档已保存: ${e.filename}`,
            ts: Date.now(),
            source: 'talker',
            actionPath: e.path,
          }],
          MAX_ACTIVITY,
        ),
      }), e.hostId);
      // Push the file path so the renderer can auto-open it as a tab
      this.mutateSlot(slot.id, (s) => ({
        ...s,
        savedDocuments: [...s.savedDocuments, e.path],
      }));
      if (slot.id === this.activeId) {
        this.announce(`文档已整理好：${e.title}`);
      }
      return;
    }
    if (e.kind === 'message') {
      this.handleMessage(slot, source, e.message, e.hostId);
    }
  }

  async setCoordinator(hostId: string): Promise<{ ok: boolean; error?: string }> {
    const slot = this.activeLiveSlot();
    if (!slot) return { ok: false, error: 'No active session' };
    const result = await window.vibeMeet.sessions.setCoordinator(slot.id, hostId);
    if (!result.ok) return result;
    this.mutateSlot(slot.id, (s) => ({ ...s, coordinatorHostId: result.coordinatorHostId }));
    return { ok: true };
  }

  async restartHost(hostId: string): Promise<{ ok: boolean; error?: string }> {
    const slot = this.activeLiveSlot();
    if (!slot) return { ok: false, error: 'No active session' };
    return window.vibeMeet.sessions.restartHost(slot.id, hostId);
  }

  /** Human-friendly name for spoken status lines. */
  private workerLabel(slot: SlotInternal, id: AgentSource, hostId?: string): string {
    if (id === 'talker') {
      const hg = slot.state.hostGroups.get(hostId ?? 'default');
      return hg ? `助手(${hg.backendId})` : '助手';
    }
    const key = this.talkerWorkerKey(id, hostId);
    return slot.state.workers.get(key)?.title || '工作者';
  }

  /** Compute the worker map key for a talker, scoped by hostId so multiple
   *  hosts' talkers don't collide under the same 'talker' key. Workers use
   *  their unique workerId directly, so they don't need this. */
  private talkerWorkerKey(source: AgentSource, hostId?: string): string {
    if (source !== 'talker') return source;
    if (!hostId || hostId === 'default') return 'talker';
    return `talker:${hostId}`;
  }

  private updateWorker(slot: SlotInternal, id: AgentSource, patch: (w: WorkerState) => WorkerState, hostId?: string) {
    const key = this.talkerWorkerKey(id, hostId);
    this.mutateSlot(slot.id, (s) => {
      const current = s.workers.get(key) ?? this.makeBlankWorker(id, hostId);
      const next = patch(current);
      const workers = new Map(s.workers);
      workers.set(key, next);
      return { ...s, workers };
    });
  }

  private makeBlankWorker(id: AgentSource, hostId?: string): WorkerState {
    return {
      id,
      title: id,
      role: id === 'talker' ? 'talker' : 'worker',
      status: 'running',
      deps: [],
      transcript: [],
      activity: [],
      pendingPermission: null,
      currentTool: null,
      currentToolInput: null,
      lastText: '',
      endedAt: null,
      summary: '',
      specialty: 'general',
      startedAt: null,
      taskHistory: [],
      hostId: hostId ?? 'default',
    };
  }

  private handleAgentApiError(slot: SlotInternal, source: AgentSource, code: string, msg?: any, hostId?: string) {
    // The SDK frequently carries the real, human-readable API error inside the
    // assistant message content (and a request_id for support). For opaque
    // codes like 'unknown' this underlying text is the only actionable signal,
    // so we always extract and append it rather than discard the payload.
    // Defense in depth: stderr is already redacted at the source in
    // claude-session, but message content can also echo credentials, so scrub
    // both before anything reaches the UI / lastError.
    const contentDetail = redactSecrets(extractText(msg?.message?.content).trim());
    // errorDetail is the CLI stderr tail captured in claude-session; for opaque
    // codes like 'unknown' it's often the only place the real HTTP error shows.
    const stderrDetail = typeof msg?.errorDetail === 'string' ? redactSecrets(msg.errorDetail.trim()) : '';
    const detail = [contentDetail, stderrDetail].filter(Boolean).join('\n');
    const requestId = typeof msg?.request_id === 'string' ? msg.request_id : '';
    const friendly = (() => {
      switch (code) {
        case 'invalid_request':
          return '上下文超出模型窗口（可能是附件太大）。请清空会话或重新发起,然后用更小的附件或拆分发送。';
        case 'rate_limit':
          return '触发模型限流,稍后再试。';
        case 'max_output_tokens':
          return '模型输出超过上限,请缩小一次提问的范围。';
        case 'server_error':
          return '模型服务暂时不可用,稍后再试。';
        case 'authentication_failed':
        case 'oauth_org_not_allowed':
          return '认证失败,请检查 ANTHROPIC_API_KEY / 登录状态。';
        case 'billing_error':
          return '账户额度问题,请检查计费状态。';
        case 'model_not_found':
          return '模型不可用,请检查配置中的模型 ID。';
        case 'unknown':
          return '模型请求失败（SDK 未能归类）。常见原因:网络/代理不可达、API Key 或 Base URL 配置有误。';
        default:
          return `Agent API error: ${code}`;
      }
    })();
    const fullDetail = [
      friendly,
      detail ? `详情: ${detail}` : '',
      requestId ? `request_id: ${requestId}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.updateWorker(slot, source, (w) => ({
      ...w,
      activity: appendCapped(
        w.activity,
        [{ id: uid(), kind: 'error', title: 'API error', detail: fullDetail, ts: Date.now(), source }],
        MAX_ACTIVITY,
      ),
    }), hostId);
    this.mutateSlot(slot.id, (s) => ({ ...s, lastError: fullDetail }));
    this.bumpUnread(slot);
  }

  private handleMessage(slot: SlotInternal, source: AgentSource, msg: any, hostId?: string) {
    const type = msg?.type;
    // Sentence-streaming path: only the talker has a streaming TTS sink; for
    // workers we ignore stream_events entirely (their narration is already
    // suppressed at the talker level). The flag `includePartialMessages` may
    // be off in current builds — in that case no stream_event will ever land
    // here and we fall back to the one-shot `assistant` path below.
    if (type === 'stream_event' && source === 'talker' && (hostId ?? 'default') === slot.state.coordinatorHostId) {
      this.handleTalkerStreamEvent(slot, msg);
      return;
    }
    if (type === 'assistant') {
      if (typeof msg?.error === 'string' && msg.error.length > 0) {
        this.handleAgentApiError(slot, source, msg.error as string, msg, hostId);
        return;
      }
      const content = msg?.message?.content;
      const text = extractText(content);
      const tools = extractToolUses(content);
      // TTS: only the active slot's talker speaks immediately. For background
      // tabs we stash the most recent talker text in pendingSpeak so setActive
      // can replay it on switch-in (B3 — previously the gate dropped these
      // messages entirely once activeId drifted off mid-reply).
      //
      // Streaming dedupe: when sentence-streaming already covered this reply
      // (stream_event deltas + message_stop fired streamCallback for every
      // sentence), the eventual full-message `assistant` payload arrives with
      // the same message.id. Speak again here would say the whole thing twice
      // — so we let the transcript update but suppress speakCallback.
      const isTalkerText = source === 'talker' && text.trim().length > 0;
      const isCoordinatorTalker = isTalkerText && (hostId ?? 'default') === slot.state.coordinatorHostId;
      const fullMessageId = typeof msg?.message?.id === 'string' ? msg.message.id : null;
      const alreadyStreamed =
        isCoordinatorTalker &&
        slot.streamBuffer.hasEmitted &&
        fullMessageId !== null &&
        fullMessageId === slot.streamBuffer.messageId;
      // Barge-in dedupe: if the user talked over the AI mid-stream, the
      // playback queue is already cancelled. The full message arrives
      // anyway — speak again would restart the speech we just killed.
      const bargedThisTurn =
        isCoordinatorTalker &&
        slot.streamBuffer.cancelledByBarge &&
        fullMessageId !== null &&
        fullMessageId === slot.streamBuffer.messageId;
      // Id-independent dedupe defense: the checks above assume the partial
      // stream's `message_start` id equals the full `assistant` message id. If
      // a future SDK lets them diverge, alreadyStreamed/bargedThisTurn both
      // fall through and the whole reply gets re-spoken via supersede. Guard
      // against that with a signal that does NOT depend on id equality: if THIS
      // turn already drove the streaming sink (hasEmitted) or was barged, and
      // there is a live stream turn (messageId set) whose id does not match the
      // full message, it is the same reply — suppress the duplicate speak.
      const streamTurnActive =
        isCoordinatorTalker &&
        slot.streamBuffer.messageId !== null &&
        (slot.streamBuffer.hasEmitted || slot.streamBuffer.cancelledByBarge);
      const streamedIdDrift =
        streamTurnActive && fullMessageId !== slot.streamBuffer.messageId;
      if (streamedIdDrift) {
        console.warn(
          '[meeting-store] talker message.id drift — streamed turn',
          slot.streamBuffer.messageId,
          'vs full message',
          fullMessageId,
          '; suppressing duplicate speak',
        );
      }
      const shouldSpeak =
        isCoordinatorTalker &&
        text !== slot.lastSpoken &&
        slot.id === this.activeId &&
        !alreadyStreamed &&
        !bargedThisTurn &&
        !streamedIdDrift;
      if (shouldSpeak) slot.lastSpoken = text;
      // Once the full message lands, the streaming-side state for THIS reply
      // is consumed — reset it so the next reply (which may not be streamed)
      // doesn't accidentally inherit the flag. Also pin lastSpoken so a
      // subsequent activate-on-tab pendingSpeak replay doesn't repeat it.
      if (alreadyStreamed || bargedThisTurn || streamedIdDrift) {
        slot.lastSpoken = text;
        slot.streamBuffer = { messageId: null, pendingTail: '', hasEmitted: false, cancelledByBarge: false };
      }
      if (isCoordinatorTalker && slot.id !== this.activeId && text !== slot.lastSpoken) {
        slot.pendingSpeak = { text, ts: Date.now() };
      }
      // Stamp the talker transcript entry once outside updateWorker so the
      // same id/ts gets mirrored to disk (otherwise the persist step would
      // generate a fresh uid + new Date.now() and disagree with what the UI
      // shows).
      const talkerEntry: TranscriptEntry | null =
        source === 'talker' && text.trim().length > 0
          ? { id: uid(), role: 'assistant', text, ts: Date.now(), hostId }
          : null;
      this.updateWorker(slot, source, (w) => {
        let next: WorkerState = w;
        if (text.trim().length > 0) {
          if (source === 'talker' && talkerEntry) {
            next = {
              ...next,
              transcript: appendCapped(
                next.transcript,
                [talkerEntry],
                MAX_TRANSCRIPT,
              ),
              lastText: text,
            };
          } else {
            next = {
              ...next,
              lastText: text,
              activity: appendCapped(
                next.activity,
                [{
                  id: uid(),
                  kind: 'system',
                  title: 'Worker thought',
                  detail: text.slice(0, 300),
                  ts: Date.now(),
                  source,
                }],
                MAX_ACTIVITY,
              ),
            };
          }
        }
        if (tools.length > 0) {
          const visible = tools.filter(
            (t) => !(source === 'talker' && MEETING_TOOL_NAMES.has(t.name)),
          );
          if (visible.length > 0) {
            const last = visible[visible.length - 1];
            const input = typeof last.input === 'object' && last.input !== null
              ? JSON.stringify(last.input).slice(0, 80)
              : String(last.input ?? '');
            next = {
              ...next,
              currentTool: last.name,
              currentToolInput: input,
              activity: appendCapped(
                next.activity,
                visible.map((t) => ({
                  id: uid(),
                  kind: 'tool-call' as const,
                  title: `Tool: ${t.name}`,
                  detail: JSON.stringify(t.input).slice(0, 200),
                  ts: Date.now(),
                  source,
                })),
                MAX_ACTIVITY,
              ),
            };
          }
        }
        return next;
      }, hostId);
      if (talkerEntry) this.persistTalkerEntry(slot, talkerEntry);
      if (shouldSpeak) this.speakCallback?.supersede(text);
      if (source === 'talker' && text.trim().length > 0) this.bumpUnread(slot);
      return;
    }
    if (type === 'user') {
      const content = msg?.message?.content;
      if (!Array.isArray(content)) return;
      const results = content.filter((b: any) => b?.type === 'tool_result');
      if (results.length === 0 || source === 'talker') return;
      this.updateWorker(slot, source, (w) => ({
        ...w,
        currentTool: null,
        currentToolInput: null,
        activity: appendCapped(
          w.activity,
          results.map((r: any) => ({
            id: uid(),
            kind: 'tool-result' as const,
            title: `Tool result${r.is_error ? ' (error)' : ''}`,
            detail: typeof r.content === 'string'
              ? r.content.slice(0, 300)
              : JSON.stringify(r.content).slice(0, 300),
            ts: Date.now(),
            source,
          })),
          MAX_ACTIVITY,
        ),
      }));
      return;
    }
    if (type === 'result') {
      if (source === 'talker') return;
      this.updateWorker(slot, source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: 'Worker turn complete', detail: msg?.subtype ?? '', ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
      return;
    }
    if (type === 'system') {
      this.updateWorker(slot, source, (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'system', title: 'System', detail: msg?.subtype ?? '', ts: Date.now(), source }],
          MAX_ACTIVITY,
        ),
      }));
    }
  }

  /** Drive sentence-streaming TTS off the talker's partial-message stream.
   *
   *  The Anthropic SDK emits one `stream_event` per low-level Anthropic stream
   *  frame; we only react to text-delta and message-stop. Anything else
   *  (signature_delta, input_json_delta, content_block_start, ping, etc.)
   *  passes through as a no-op so we don't churn state on every frame.
   *
   *  Background tabs (`slot.id !== activeId`) skip the speak path entirely —
   *  switching tabs mid-stream would otherwise interleave two reply streams
   *  on the same speech queue. Their fallback path (full assistant message →
   *  pendingSpeak replay) still works on tab switch-in. */
  private handleTalkerStreamEvent(slot: SlotInternal, msg: any) {
    if (slot.id !== this.activeId) return;
    const cb = this.speakCallback;
    if (!cb) return;
    const event = msg?.event;
    const eventType = event?.type;

    if (eventType === 'message_start') {
      // New reply boundary — reset the buffer so a previous reply's tail
      // doesn't bleed into this one. Capture the message id; it doubles as
      // the turnId for the SpeakHandle so subsequent enqueues for the same
      // reply are routed to the same in-flight session (append, not
      // supersede).
      const id = typeof event?.message?.id === 'string' ? event.message.id : null;
      slot.streamBuffer = { messageId: id, pendingTail: '', hasEmitted: false, cancelledByBarge: false };
      return;
    }

    // Barge-in: drop any further stream events for this turn. The playback
    // queue has already been cancelled by the renderer; we just need to not
    // re-arm it on the next delta.
    if (slot.streamBuffer.cancelledByBarge) return;

    if (eventType === 'content_block_delta') {
      const delta = extractStreamDeltaText(event);
      if (!delta) return;
      const turnId = slot.streamBuffer.messageId;
      if (!turnId) return;
      slot.streamBuffer.pendingTail += delta;
      const { ready, tail } = takeReadySentences(slot.streamBuffer.pendingTail);
      if (!ready) return;
      slot.streamBuffer.pendingTail = tail;
      const wasFirst = !slot.streamBuffer.hasEmitted;
      slot.streamBuffer.hasEmitted = true;
      try { cb.enqueue(ready, turnId, { isFirstChunk: wasFirst }); } catch (err) {
        console.warn('[meeting-store] speakCallback.enqueue threw:', err);
      }
      return;
    }

    if (eventType === 'message_stop' || eventType === 'message_delta') {
      // message_stop is the only guaranteed terminal frame; message_delta
      // with stop_reason set is its precursor on some SDK versions. Either
      // way we flush the trailing partial as the final chunk, then close
      // the turn so the SpeakHandle can drain onAllDone.
      const stopReason = event?.delta?.stop_reason ?? event?.stop_reason ?? null;
      if (eventType === 'message_delta' && !stopReason) return;
      const tail = slot.streamBuffer.pendingTail;
      slot.streamBuffer.pendingTail = '';
      const hasEmitted = slot.streamBuffer.hasEmitted;
      const turnId = slot.streamBuffer.messageId;
      // No-op if we never emitted AND have no tail — nothing to speak. This
      // protects App.tsx from a dangling onAllDone for a reply that never
      // started its speech queue.
      if (!hasEmitted && !tail.trim()) return;
      if (!turnId) return;
      try {
        if (tail.trim().length > 0) {
          cb.enqueue(tail, turnId, { isFinal: true });
        } else {
          cb.markTurnComplete(turnId);
        }
      } catch (err) {
        console.warn('[meeting-store] speakCallback (final) threw:', err);
      }
      return;
    }
  }

  // --- Active-slot send API (back-compat for components/hooks) --------------

  async restartSession() {
    const id = this.activeId;
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot || slot.placeholder) return;
    const cwd = slot.cwd;
    const greeting = slot.greeting;
    slot.intendedExit = true;
    try { await window.vibeMeet.endSession(id); } catch (err) {
      console.warn('[meeting-store] endSession (restart) failed', { id, err });
    }
    try { await window.vibeMeet.sessions.close(id); } catch (err) {
      console.warn('[meeting-store] sessions.close (restart) failed', { id, err });
    }
    // C1: tearing down the active slot — drop its queued announcements so they
    // don't fire into the freshly reopened session.
    this.announceQueue = [];
    this.clearAnnounceTimer();
    this.slots.delete(id);
    this.activeId = null;
    this.notifyTabsOnly();
    await this.openSession(cwd, greeting);
  }

  /** Retry a failed slot: drop the dead slot and re-open the same cwd. The
   *  TabStrip exposes this on tabs whose status is 'failed'. */
  async retryFailedTab(id: string): Promise<{ ok: boolean; error?: string }> {
    const slot = this.slots.get(id);
    if (!slot || slot.placeholder) return { ok: false, error: 'not-found' };
    if (slot.status !== 'failed') return { ok: false, error: 'not-failed' };
    const cwd = slot.cwd;
    const greeting = slot.greeting;
    try { await window.vibeMeet.sessions.close(id); } catch (err) {
      console.warn('[meeting-store] sessions.close (retry) failed', { id, err });
    }
    this.slots.delete(id);
    if (this.activeId === id) {
      // C1: only the active slot owns the announce queue; drop it so stale
      // status lines don't replay into the reopened session.
      this.announceQueue = [];
      this.clearAnnounceTimer();
      this.activeId = null;
    }
    this.notifyTabsOnly();
    return this.openSession(cwd, greeting);
  }

  /** Returns the active live (non-placeholder) slot regardless of ready
   *  state, so sendText/sendImage/sendAttachments can buffer to pendingInput
   *  while the SDK is still spawning. */
  private activeLiveSlot(): SlotInternal | null {
    if (!this.activeId) return null;
    const slot = this.slots.get(this.activeId);
    if (!slot || slot.placeholder) return null;
    return slot;
  }

  async sendText(text: string) {
    if (!text.trim()) return;
    const slot = this.activeLiveSlot();
    if (!slot) return;
    if (slot.status === 'failed') return;
    const entryId = uid();
    const entry: TranscriptEntry = { id: entryId, role: 'user', text, ts: Date.now() };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [entry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, entry);
    if (slot.status !== 'ready') {
      slot.pendingInput.push({ kind: 'text', text });
      return;
    }
    try {
      await window.vibeMeet.sendUserText(slot.id, text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[meeting-store] sendText failed:', msg);
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: 'Text send failed', detail: msg, ts: Date.now() }],
          MAX_ACTIVITY,
        ),
      }));
    }
  }

  async sendImage(dataUrl: string, caption: string) {
    const slot = this.activeLiveSlot();
    if (!slot) return;
    if (slot.status === 'failed') return;
    const entryId = uid();
    const entry: TranscriptEntry = {
      id: entryId,
      role: 'user',
      text: caption || 'Shared current screen',
      imageUrl: dataUrl,
      ts: Date.now(),
    };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [entry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, entry);
    if (slot.status !== 'ready') {
      slot.pendingInput.push({ kind: 'image', dataUrl, caption });
      return;
    }
    try {
      await window.vibeMeet.sendUserImage(slot.id, dataUrl, caption);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[meeting-store] sendImage failed:', msg);
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        transcript: w.transcript.filter((t) => t.id !== entryId),
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: 'Image send failed', detail: msg, ts: Date.now() }],
          MAX_ACTIVITY,
        ),
      }));
    }
  }

  async sendAttachments(
    staged: StagedAttachment[],
    text: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (staged.length === 0 && !text.trim()) return { ok: false, error: 'Nothing to send' };
    const slot = this.activeLiveSlot();
    if (!slot) return { ok: false, error: 'No active session' };
    if (slot.status === 'failed') return { ok: false, error: 'Session failed to start' };
    const meta: AttachmentMeta[] = staged.map((a) => ({ name: a.name, kind: a.kind, sizeBytes: a.sizeBytes }));
    const transcriptText = text.trim().length > 0 ? text : `Sent ${staged.length} file${staged.length === 1 ? '' : 's'}`;
    const entryId = uid();
    const entry: TranscriptEntry = {
      id: entryId,
      role: 'user',
      text: transcriptText,
      attachments: meta.length > 0 ? meta : undefined,
      ts: Date.now(),
    };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [entry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, entry);
    if (slot.status !== 'ready') {
      slot.pendingInput.push({ kind: 'attachments', staged, text });
      return { ok: true };
    }
    const wire = staged.map((a) => ({
      name: a.name,
      mime: a.mime,
      sizeBytes: a.sizeBytes,
      dataBase64: a.dataBase64,
    }));
    try {
      const res = await window.vibeMeet.sendUserAttachments(slot.id, wire, text);
      if (!res.ok) {
        this.updateWorker(slot, 'talker', (w) => ({
          ...w,
          transcript: w.transcript.filter((t) => t.id !== entryId),
          activity: appendCapped(
            w.activity,
            [{ id: uid(), kind: 'error', title: 'Attachment send failed', detail: res.error, ts: Date.now() }],
            MAX_ACTIVITY,
          ),
        }));
        return { ok: false, error: res.error };
      }
      return { ok: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.updateWorker(slot, 'talker', (w) => ({
        ...w,
        transcript: w.transcript.filter((t) => t.id !== entryId),
        activity: appendCapped(
          w.activity,
          [{ id: uid(), kind: 'error', title: 'Attachment send failed', detail: msg, ts: Date.now() }],
          MAX_ACTIVITY,
        ),
      }));
      return { ok: false, error: msg };
    }
  }

  // Window-level drag-and-drop fan-out (unchanged).
  private droppedFileListeners = new Set<(files: File[]) => void>();
  publishDroppedFiles(files: File[]) {
    if (files.length === 0) return;
    for (const cb of this.droppedFileListeners) {
      try { cb(files); } catch (err) {
        console.warn('[meeting-store] droppedFiles subscriber threw', err);
      }
    }
  }
  onDroppedFiles(cb: (files: File[]) => void): () => void {
    this.droppedFileListeners.add(cb);
    return () => { this.droppedFileListeners.delete(cb); };
  }

  async resolvePermission(id: string, decision: 'allow' | 'deny') {
    const sessionId = this.effectiveSessionId();
    if (!sessionId) return;
    const slot = this.slots.get(sessionId);
    if (!slot) return;
    try {
      await window.vibeMeet.resolvePermission(sessionId, id, decision);
    } catch (err) {
      console.error('[meeting-store] resolvePermission IPC failed:', err);
    }
    this.mutateSlot(slot.id, (s) => {
      const workers = new Map(s.workers);
      for (const [key, w] of workers) {
        if (w.pendingPermission?.id === id) {
          workers.set(key, { ...w, pendingPermission: null });
        }
      }
      return { ...s, workers };
    });
  }

  async interrupt() {
    const id = this.effectiveSessionId();
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot) return;
    try {
      await window.vibeMeet.interrupt(id);
    } catch (err) {
      console.warn('[meeting-store] interrupt IPC failed:', err);
      return;
    }
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      activity: appendCapped(
        w.activity,
        [{ id: uid(), kind: 'system', title: 'Interrupted', ts: Date.now() }],
        MAX_ACTIVITY,
      ),
    }));
  }

  async endSession() {
    const id = this.activeId;
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot || slot.placeholder) return;
    slot.intendedExit = true;
    try {
      await window.vibeMeet.endSession(id);
    } catch (err) {
      console.error('[meeting-store] endSession IPC failed:', err);
    }
    this.mutateSlot(slot.id, (s) => ({ ...s, running: false, lastError: null }));
  }

  // --- Delivery acceptance --------------------------------------------------

  /** Dismiss the staged delivery — user signed off on the work. We don't
   *  echo anything back to the worker; the absence of feedback IS the
   *  acceptance signal (worker has already been disposed by markTaskDone). */
  acceptDelivery() {
    const id = this.effectiveSessionId();
    if (!id) return;
    const slot = this.slots.get(id);
    if (!slot || !slot.state.currentDelivery) return;
    const taskId = slot.state.currentDelivery.taskId;
    this.mutateSlot(slot.id, (s) => ({
      ...s,
      currentDelivery: null,
      deliveryHistory: s.deliveryHistory.map((d) =>
        d.taskId === taskId ? { ...d, status: 'accepted' as const } : d,
      ),
    }));
  }

  /** Push revision feedback back into the meeting. Tries the worker's
   *  session first via steerWorker; if the worker has already been disposed
   *  (the usual case after markTaskDone), falls back to sending a synthetic
   *  user message to the talker so it can re-delegate. */
  async reviseDelivery(
    feedback: string,
  ): Promise<{ ok: true; route: 'worker' | 'talker'; queued?: boolean } | { ok: false; error: string }> {
    const trimmed = feedback.trim();
    if (!trimmed) return { ok: false, error: 'Empty feedback' };
    const id = this.effectiveSessionId();
    if (!id) return { ok: false, error: 'No active session' };
    const slot = this.slots.get(id);
    if (!slot || !slot.state.currentDelivery) {
      return { ok: false, error: 'No delivery staged' };
    }
    const delivery = slot.state.currentDelivery;
    const workerId = delivery.workerId;

    const directRes = await window.vibeMeet.steerWorker(id, workerId, trimmed);
    if (directRes.ok) {
      this.markDeliveryRevised(slot, workerId, trimmed);
      return { ok: true, route: 'worker', queued: directRes.queued };
    }

    // Worker already torn down (status='done'/'failed' or session gone) —
    // route through the talker so it can re-delegate. We append a transcript
    // entry that mirrors what the user sees so the chat history shows the
    // request, and we let the talker decide how to dispatch it.
    const fileLine = delivery.files.length > 0
      ? `\n相关文件:\n${delivery.files.map((f) => `  - ${f.path}`).join('\n')}`
      : '';
    const synthetic = [
      `刚才 ${workerId}「${delivery.title}」交付的内容我看过了，需要继续改:`,
      trimmed,
      fileLine,
      '请把这条修改意见交回去（可以复用同一个 worker，也可以重新派活）。',
    ].filter(Boolean).join('\n');

    await window.vibeMeet.sendUserText(id, synthetic);
    const revisionEntry: TranscriptEntry = {
      id: uid(),
      role: 'user',
      text: `[对 ${delivery.title} 的修改意见] ${trimmed}`,
      ts: Date.now(),
    };
    this.updateWorker(slot, 'talker', (w) => ({
      ...w,
      transcript: appendCapped(w.transcript, [revisionEntry], MAX_TRANSCRIPT),
    }));
    this.persistTalkerEntry(slot, revisionEntry);
    this.markDeliveryRevised(slot, workerId, trimmed);
    return { ok: true, route: 'talker' };
  }

  private markDeliveryRevised(slot: SlotInternal, workerId: AgentSource, feedback: string) {
    const taskId = slot.state.currentDelivery?.taskId;
    this.mutateSlot(slot.id, (s) => ({
      ...s,
      currentDelivery: null,
      deliveryHistory: taskId
        ? s.deliveryHistory.map((d) =>
            d.taskId === taskId ? { ...d, status: 'revised' as const } : d,
          )
        : s.deliveryHistory,
    }));
    this.updateWorker(slot, workerId, (w) => ({
      ...w,
      activity: appendCapped(
        w.activity,
        [{
          id: uid(),
          kind: 'system',
          title: '用户提出修改意见',
          detail: feedback.slice(0, 300),
          ts: Date.now(),
          source: workerId,
        }],
        MAX_ACTIVITY,
      ),
    }));
  }

  // ===========================================================================
  // Host group management

  /** Toggle the collapsed state of a host group in the active slot. */
  toggleHostGroupCollapsed(hostId: string) {
    const slot = this.getActiveSlot();
    if (!slot) return;
    this.mutateSlot(slot.id, (s) => {
      const hg = s.hostGroups.get(hostId);
      if (!hg) return s;
      const hostGroups = new Map(s.hostGroups);
      hostGroups.set(hostId, { ...hg, collapsed: !hg.collapsed });
      return { ...s, hostGroups };
    });
  }

  /** Add a host group to the active slot via IPC. */
  async addHostGroup(backendId: string): Promise<{ ok: boolean; hostId?: string; error?: string }> {
    const slot = this.getActiveSlot();
    const sessionId = slot?.id ?? null;
    const result = await window.vibeMeet.sessions.addHost(sessionId, backendId).catch(
      (err: unknown) => ({ ok: false as const, error: String(err), hostId: '' }),
    );
    if (!result.ok) return { ok: false, error: result.error };

    // Add the host group to local state.
    if (slot) {
      this.mutateSlot(slot.id, (s) => {
        const hostGroups = new Map(s.hostGroups);
        hostGroups.set(result.hostId, {
          id: result.hostId,
          backendId,
          iconId: iconIdForBackend(backendId),
          hostWorkerId: `host-${result.hostId}`,
          workerIds: [],
          collapsed: true,
        });
        return { ...s, hostGroups };
      });
    }
    return { ok: true, hostId: result.hostId };
  }

  /** Remove a host group from the active slot via IPC. */
  async removeHostGroup(hostId: string): Promise<{ ok: boolean; error?: string }> {
    const slot = this.getActiveSlot();
    const sessionId = slot?.id ?? null;
    const result = await window.vibeMeet.sessions.removeHost(sessionId, hostId).catch(
      (err: unknown) => ({ ok: false as const, error: String(err) }),
    );
    if (!result.ok) return { ok: false, error: result.error };

    if (slot) {
      this.mutateSlot(slot.id, (s) => {
        const hostGroups = new Map(s.hostGroups);
        hostGroups.delete(hostId);
        // Also remove workers belonging to this host.
        const workers = new Map(s.workers);
        for (const [id, w] of workers) {
          if (w.hostId === hostId) workers.delete(id);
        }
        return { ...s, hostGroups, workers };
      });
    }
    return { ok: true };
  }

  private getActiveSlot(): SlotInternal | null {
    if (!this.activeId) return null;
    return this.slots.get(this.activeId) ?? null;
  }
}

export const meetingStore = new MeetingStore();
