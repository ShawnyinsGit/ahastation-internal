// opencode-editor-panel.ts — pure state store + fan-out routing for the
// OpenCode editor window's live panels (Phase 2 PR③).
//
// Electron-free: the adapter feeds digested server events into
// EditorPanelStore, gets back incremental EditorPanelEvent's, and forwards
// them point-to-point to the bound editor window (§2.2 rule 7 — routing
// decision itself is the pure resolveFanOutTarget below). The store keeps
// the full snapshot so a freshly-opened/re-attached window can pull it via
// ide-editor:get-state, and caps the activity timeline so long sessions
// can't grow renderer memory without bound.

// ── Shared shapes (mirrored in src/types.ts for the renderer) ──────────────

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

/** Count +/- lines of a unified diff (permission.asked metadata carries one
 *  for edit/write requests). '+++'/'---' header lines are excluded. */
export function parseUnifiedDiffCounts(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/** opencode 1.18.4 emits session.diff events but always with diff: [] (live-
 *  verified in git and non-git dirs, snapshot flag on — server-side gap).
 *  The panel therefore keeps a DERIVED file-change list fed by completed
 *  write/edit tool calls and permission.asked diff metadata; a non-empty
 *  server session.diff always wins when it eventually carries data. */

// ── Fan-out routing (pure) ──────────────────────────────────────────────────

/** §2.2 rule 7 routing decision: which webContents (if any) owns this
 *  hostId's editor events. Returns null when no live window is bound —
 *  callers MUST then retain the data in main and never broadcast. */
export function resolveFanOutTarget(
  bindings: ReadonlyMap<string, { webContentsId: number | null }>,
  hostId: string,
): number | null {
  return bindings.get(hostId)?.webContentsId ?? null;
}

// ── Panel store ─────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export class EditorPanelStore {
  private status: EditorStatus = 'idle';
  private todos: EditorTodoItem[] = [];
  private serverDiff: EditorDiffEntry[] | null = null;
  private derivedDiff = new Map<string, EditorDiffEntry>();
  private activity: EditorKeyedActivity[] = [];
  private activityIndex = new Map<string, number>();
  private instanceSeq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private diffEntries(): EditorDiffEntry[] {
    return this.serverDiff ?? [...this.derivedDiff.values()];
  }

  snapshot(): EditorSnapshot {
    return {
      status: this.status,
      todos: this.todos.map((t) => ({ ...t })),
      diff: this.diffEntries().map((d) => ({ ...d })),
      activity: this.activity.map((a) => ({ key: a.key, item: { ...a.item } })),
    };
  }

  getStatus(): EditorStatus {
    return this.status;
  }

  private upsertActivity(key: string, item: EditorActivityItem): EditorPanelEvent {
    const existing = this.activityIndex.get(key);
    if (existing !== undefined) {
      this.activity[existing] = { key, item };
    } else {
      this.activityIndex.set(key, this.activity.length);
      this.activity.push({ key, item });
      if (this.activity.length > EDITOR_ACTIVITY_CAP) {
        const [dropped] = this.activity.splice(0, this.activity.length - EDITOR_ACTIVITY_CAP);
        // Rebuild the index after the shift (cap is large, this is cheap
        // relative to event volume — and only happens once per overflow).
        this.activityIndex.clear();
        this.activity.forEach((a, i) => this.activityIndex.set(a.key, i));
        void dropped;
      }
    }
    return { kind: 'activity-upsert', key, item };
  }

  /** Text part update, coalesced per message — the timeline shows one
   *  rolling entry per assistant message instead of one per delta. */
  noteText(messageID: string, text: string): EditorPanelEvent {
    return this.upsertActivity(`text:${messageID}`, {
      ts: this.now(),
      kind: 'text',
      label: truncate(text, 120),
    });
  }

  noteToolCall(callID: string, toolName: string, status: string, input?: Record<string, unknown>): EditorPanelEvent {
    return this.upsertActivity(`tool:${callID}`, {
      ts: this.now(),
      kind: 'tool',
      label: `${toolName} · ${status}`,
      detail: input ? truncate(JSON.stringify(input), 200) : undefined,
    });
  }

  /** Instance-level activity (file.edited / watcher / vcs / pty / ...). */
  noteInstanceActivity(label: string): EditorPanelEvent {
    this.instanceSeq += 1;
    return this.upsertActivity(`inst:${this.instanceSeq}`, {
      ts: this.now(),
      kind: 'file',
      label: truncate(label, 160),
    });
  }

  setStatus(status: EditorStatus): EditorPanelEvent | null {
    if (this.status === status) return null;
    this.status = status;
    return { kind: 'status', status };
  }

  setError(detail: string): EditorPanelEvent[] {
    const events: EditorPanelEvent[] = [];
    const statusEvent = this.setStatus('error');
    if (statusEvent) events.push(statusEvent);
    events.push(this.upsertActivity(`err:${this.now()}`, {
      ts: this.now(),
      kind: 'status',
      label: truncate(detail, 160),
    }));
    return events;
  }

  setTodos(raw: unknown): EditorPanelEvent {
    const list = Array.isArray(raw) ? raw : [];
    this.todos = list
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map((t) => ({
        id: typeof t.id === 'string' ? t.id : String(t.content ?? '').slice(0, 32),
        content: typeof t.content === 'string' ? t.content : '',
        status: typeof t.status === 'string' ? t.status : 'pending',
        priority: typeof t.priority === 'string' ? t.priority : 'medium',
      }));
    return { kind: 'todo', todos: this.snapshot().todos };
  }

  setDiff(raw: unknown): EditorPanelEvent {
    const list = Array.isArray(raw) ? raw : [];
    const parsed = list
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
      .map((d) => ({
        file: typeof d.file === 'string' ? d.file : '',
        additions: typeof d.additions === 'number' ? d.additions : 0,
        deletions: typeof d.deletions === 'number' ? d.deletions : 0,
      }))
      .filter((d) => d.file !== '');
    // Server is authoritative only when it actually carries entries — the
    // 1.18.4 empty-array events must NOT wipe the derived list.
    if (parsed.length > 0) this.serverDiff = parsed;
    return { kind: 'diff', diff: this.snapshot().diff };
  }

  /** Derived diff source (server session.diff is empty in 1.18.4): a file
   *  write/edit completed, or a permission.asked carried its unified diff.
   *  Later calls with real counts upgrade the entry. */
  noteFileChange(file: string, counts?: { additions: number; deletions: number }): EditorPanelEvent {
    const existing = this.derivedDiff.get(file);
    this.derivedDiff.set(file, {
      file,
      additions: counts?.additions ?? existing?.additions ?? 0,
      deletions: counts?.deletions ?? existing?.deletions ?? 0,
    });
    return { kind: 'diff', diff: this.snapshot().diff };
  }
}
