// companion-model.ts — companion-screen state-model KERNEL (Phase 8, §3.4).
//
// Electron-free and renderer-free: orchestrator-side inputs (participant
// roster + meeting events + TTS-active flag) go in, a render-agnostic
// CompanionState comes out (seat assignments, per-participant status
// machine, bubble queue, mascot aggregate text, alert levels). The Phaser
// scene and the IPC feed both depend only on these pure functions — every
// rule from the spec is unit-testable here:
//   seats: fixed 6 slots; join = sit, leave = dusty vacant desk,
//          overflow = standing area
//   bubbles: TTS-same-source text, ≤40 chars hard cut, ≤8s replace-with-
//          count-badge lifecycle, non-dialog events → fixed phrase
//          templates (never raw event payloads)
//   mascot: aggregate is the LEVEL-1 information ("3 人工作中 · 1 人卡住 ·
//          1 条待审批"), per-participant bubbles are level-2 ambience

// ── Constants (spec) ────────────────────────────────────────────────────────

export const COMPANION_MAX_SEATS = 6;
export const BUBBLE_MAX_LEN = 40;
export const BUBBLE_TTL_MS = 8000;
export const PERMISSION_PHRASE = '等待审批';
export const DELIVERY_PHRASE = '交付完成 ✓';

// ── Seat assignment ─────────────────────────────────────────────────────────

export type CompanionSeat = number | 'standing';

export interface SeatAssignment {
  hostId: string;
  seat: CompanionSeat;
  /** Previously seated, now absent — the desk stays, dusty and vacant. */
  vacated: boolean;
}

/** Fixed 6-slot seating: previous seats are kept, new hosts take the lowest
 *  free slot, absent hosts leave a vacated (dusty) desk, overflow stands. */
export function assignSeats(
  orderedHostIds: readonly string[],
  previousSeats: ReadonlyMap<string, number>,
  maxSeats: number = COMPANION_MAX_SEATS,
): SeatAssignment[] {
  const taken = new Set<number>();
  const out: SeatAssignment[] = [];

  for (const hostId of orderedHostIds) {
    const prev = previousSeats.get(hostId);
    if (prev !== undefined && prev < maxSeats && !taken.has(prev)) {
      taken.add(prev);
      out.push({ hostId, seat: prev, vacated: false });
    }
  }
  const seated = new Set(out.map((a) => a.hostId));
  for (const hostId of orderedHostIds) {
    if (seated.has(hostId)) continue;
    let free = -1;
    for (let s = 0; s < maxSeats; s += 1) {
      if (!taken.has(s)) {
        free = s;
        break;
      }
    }
    if (free >= 0) {
      taken.add(free);
      out.push({ hostId, seat: free, vacated: false });
      seated.add(hostId);
    } else {
      out.push({ hostId, seat: 'standing', vacated: false });
      seated.add(hostId);
    }
  }
  // Dusty desks: previously seated hosts no longer present.
  for (const [hostId, seat] of previousSeats) {
    if (!seated.has(hostId) && seat < maxSeats) {
      out.push({ hostId, seat, vacated: true });
    }
  }
  return out;
}

// ── Bubbles ─────────────────────────────────────────────────────────────────

export interface CompanionBubble {
  text: string;
  startedAt: number;
  /** Backlog counter rendered as the ×N badge (replaced within the TTL). */
  count: number;
}

/** Hard 40-char cut with an ellipsis tail (spec ②). */
export function truncateBubble(text: string, maxLen: number = BUBBLE_MAX_LEN): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen - 1)}…`;
}

/** One bubble per character at a time (spec ③): a new message REPLACES the
 *  old one and bumps the backlog count (spec ④). */
export function pushBubble(
  existing: CompanionBubble | null,
  text: string,
  now: number,
): CompanionBubble {
  const truncated = truncateBubble(text);
  if (existing && now - existing.startedAt <= BUBBLE_TTL_MS) {
    return { text: truncated, startedAt: now, count: existing.count + 1 };
  }
  return { text: truncated, startedAt: now, count: 1 };
}

/** TTL filter (spec ③): returns the bubble only while it is alive. */
export function bubbleVisible(bubble: CompanionBubble | null, now: number): CompanionBubble | null {
  if (!bubble) return null;
  return now - bubble.startedAt <= BUBBLE_TTL_MS ? bubble : null;
}

/** Non-dialog events map to FIXED phrase templates (spec ⑤) — raw tool
 *  payloads never become bubble text. */
export function phraseForTool(toolName: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? input.file_path.split('/').pop() : null;
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `正在编辑 ${file}` : '正在编辑文件';
    case 'Bash':
      return '正在跑命令';
    case 'Read':
    case 'Glob':
    case 'Grep':
      return '正在查看代码';
    case 'Task':
      return '正在派发子任务';
    case 'WebFetch':
    case 'WebSearch':
      return '正在查资料';
    default:
      return `正在用 ${toolName}`;
  }
}

// ── Participant status machine ──────────────────────────────────────────────

export type CompanionStatus = 'idle' | 'working' | 'stalled' | 'celebrating' | 'alert';
export type AlertLevel = 'none' | 'light' | 'strong';

export interface CompanionParticipant {
  hostId: string;
  backendId: string;
  seat: CompanionSeat;
  vacated: boolean;
  status: CompanionStatus;
  statusChangedAt: number;
  bubble: CompanionBubble | null;
  pendingPermission: boolean;
}

export type CompanionEvent =
  | { kind: 'text'; hostId: string; text: string }
  | { kind: 'tool'; hostId: string; toolName: string; input: Record<string, unknown> }
  | { kind: 'idle-signal'; hostId: string }
  | { kind: 'stalled'; hostId: string }
  | { kind: 'ended'; hostId: string; status: 'done' | 'failed' | 'interrupted' }
  | { kind: 'delivered'; hostId: string }
  | { kind: 'permission-pending'; hostId: string }
  | { kind: 'permission-cleared'; hostId: string };

export function reduceParticipant(
  p: CompanionParticipant,
  e: CompanionEvent,
  now: number,
): CompanionParticipant {
  const at = (status: CompanionStatus): CompanionParticipant =>
    ({ ...p, status, statusChangedAt: now });
  switch (e.kind) {
    case 'text':
      return { ...at('working'), bubble: pushBubble(p.bubble, e.text, now) };
    case 'tool':
      return { ...at('working'), bubble: pushBubble(p.bubble, phraseForTool(e.toolName, e.input), now) };
    case 'idle-signal':
      return { ...at('idle'), pendingPermission: false };
    case 'stalled':
      return at('stalled');
    case 'ended':
      if (e.status === 'done') return at('celebrating');
      if (e.status === 'failed') return at('alert');
      return at('idle');
    case 'delivered':
      return { ...at('celebrating'), bubble: pushBubble(p.bubble, DELIVERY_PHRASE, now) };
    case 'permission-pending':
      return { ...at('alert'), pendingPermission: true, bubble: pushBubble(p.bubble, PERMISSION_PHRASE, now) };
    case 'permission-cleared':
      return { ...at('idle'), pendingPermission: false };
    default:
      return p;
  }
}

// ── Mascot aggregate (level-1 information) ──────────────────────────────────

export interface MascotAggregate {
  text: string;
  alertLevel: AlertLevel;
}

/** "3 人工作中 · 1 人卡住 · 1 条待审批" — the aggregate is what the mascot
 *  says; per-participant bubbles stay ambience. Alert grading: any pending
 *  permission → strong (权限请求=强提醒); anyone celebrating → light
 *  (交付=轻提示). Vacated desks never count. */
export function buildAggregate(
  participants: readonly CompanionParticipant[],
): MascotAggregate {
  const live = participants.filter((p) => !p.vacated);
  const working = live.filter((p) => p.status === 'working').length;
  const stalled = live.filter((p) => p.status === 'stalled').length;
  const pending = live.filter((p) => p.pendingPermission).length;

  const parts: string[] = [];
  if (working > 0) parts.push(`${working} 人工作中`);
  if (stalled > 0) parts.push(`${stalled} 人卡住`);
  if (pending > 0) parts.push(`${pending} 条待审批`);

  const alertLevel: AlertLevel = pending > 0 ? 'strong'
    : live.some((p) => p.status === 'celebrating') ? 'light'
      : 'none';
  return { text: parts.length > 0 ? parts.join(' · ') : '大家都在空闲', alertLevel };
}

// ── The model ───────────────────────────────────────────────────────────────

export interface CompanionState {
  participants: CompanionParticipant[];
  mascot: MascotAggregate & { coordinatorHostId: string };
  ttsActive: boolean;
}

export class CompanionModel {
  private participants = new Map<string, CompanionParticipant>();
  private coordinatorHostId = 'default';
  private ttsActive = false;

  /** Reconcile the roster with the meeting's host list (called by the feed
   *  on roster-affecting events). Seats are reassigned deterministically. */
  setRoster(hosts: readonly { id: string; backendId: string; role: string }[], now: number): void {
    const previousSeats = new Map<string, number>();
    for (const p of this.participants.values()) {
      if (typeof p.seat === 'number') previousSeats.set(p.hostId, p.seat);
    }
    const coordinator = hosts.find((h) => h.role === 'coordinator');
    if (coordinator) this.coordinatorHostId = coordinator.id;

    const assignments = assignSeats(hosts.map((h) => h.id), previousSeats);
    const next = new Map<string, CompanionParticipant>();
    for (const a of assignments) {
      const host = hosts.find((h) => h.id === a.hostId);
      const existing = this.participants.get(a.hostId);
      next.set(a.hostId, {
        hostId: a.hostId,
        backendId: host?.backendId ?? existing?.backendId ?? '',
        seat: a.seat,
        vacated: a.vacated,
        status: a.vacated ? 'idle' : (existing?.status ?? 'idle'),
        statusChangedAt: existing?.statusChangedAt ?? now,
        bubble: a.vacated ? null : (existing?.bubble ?? null),
        pendingPermission: a.vacated ? false : (existing?.pendingPermission ?? false),
      });
    }
    this.participants = next;
  }

  ingest(e: CompanionEvent, now: number): void {
    const p = this.participants.get(e.hostId);
    if (!p || p.vacated) return;
    this.participants.set(e.hostId, reduceParticipant(p, e, now));
  }

  setTtsActive(active: boolean): void {
    this.ttsActive = active;
  }

  reset(): void {
    this.participants.clear();
  }

  state(now: number): CompanionState {
    const participants = [...this.participants.values()].map((p) => ({
      ...p,
      bubble: bubbleVisible(p.bubble, now),
    }));
    return {
      participants,
      mascot: { ...buildAggregate(participants), coordinatorHostId: this.coordinatorHostId },
      ttsActive: this.ttsActive,
    };
  }
}
