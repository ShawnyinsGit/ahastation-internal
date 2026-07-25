// session-actions.ts — Host voice-intent actions on observed sessions.
//
// The observation layer is read-only by design (TD-7); THIS module is the
// deliberate, approval-gated exception: the meeting Host resolves which
// observed window the user means ("ahakeyconfig 那个 Kimi 窗口") and acts on
// it — typing text into the session's terminal (派任务 / 批准) or bringing
// the owning window to the front. Every action is invoked from a Host MCP
// tool that the auto-approve policy carves OUT of the safe list, so each
// call surfaces as a user approval first.
//
// Electron-free: exec / writeFile / now are injectable so `node --test`
// exercises everything through dist-electron. No function here ever throws —
// failures come back as typed results the Host can read aloud.

import { promises as fs } from 'node:fs';
import { boardableObservedSessions } from './board-visibility.js';
import { defaultExec, type ExecImpl } from './util.js';
import type { ObservedActivity, ObservedSession, ObservedSnapshot, ObservedState } from './types.js';

export const SEND_TEXT_MAX_CHARS = 500;
export const SEND_TEXT_RATE_LIMIT_MS = 2_000;
const FOCUS_TIMEOUT_MS = 3_000;
const ACTION_MAX_BUFFER = 1024 * 1024;

export interface SessionActionDeps {
  execImpl?: ExecImpl;
  writeFileImpl?: (path: string, data: string) => Promise<unknown>;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Target rows + resolution (the Host "which window did you mean" resolver)
// ---------------------------------------------------------------------------

/** What the Host list tool reports per session — enough to name the window
 *  and to know whether direct terminal input is even possible (tty). */
export interface ObservedSessionToolRow {
  id: string;
  clientKind: ObservedSession['clientKind'];
  projectName: string;
  title: string;
  state: ObservedState;
  activity: ObservedActivity;
  tty?: string;
  lastActiveAt: number;
}

export function observedSessionToolRow(session: ObservedSession): ObservedSessionToolRow {
  return {
    id: session.id,
    clientKind: session.clientKind,
    projectName: session.projectName,
    title: session.title,
    state: session.state,
    activity: session.activity,
    ...(session.tty ? { tty: session.tty } : {}),
    lastActiveAt: session.lastActiveAt,
  };
}

/** Sessions the Host may act on (same board-visibility rule as the AhaBar),
 *  shaped as tool rows, sorted for display. */
export function listBoardableObservedSessionRows(
  snapshot: ObservedSnapshot,
  now: number,
): ObservedSessionToolRow[] {
  return boardableObservedSessions(snapshot.sessions, now).map(observedSessionToolRow);
}

export type ObservedSessionResolution =
  | { kind: 'ok'; session: ObservedSession }
  | { kind: 'not-found'; id: string }
  | { kind: 'ambiguous'; id: string; candidates: ObservedSessionToolRow[] };

/** Resolve a tool-call id against the actionable session set. Exact id wins;
 *  a ≥4-char unique prefix is accepted as a convenience (sha1 ids are
 *  unwieldy in voice transcripts). Two or more candidates NEVER resolve —
 *  the Host must ask the user instead of guessing. */
export function resolveObservedSession(
  sessions: ObservedSession[],
  id: string,
): ObservedSessionResolution {
  const wanted = id.trim();
  const exact = sessions.find((session) => session.id === wanted);
  if (exact) return { kind: 'ok', session: exact };
  const matches = wanted.length >= 4
    ? sessions.filter((session) => session.id.startsWith(wanted))
    : [];
  if (matches.length === 1) return { kind: 'ok', session: matches[0] };
  if (matches.length > 1) {
    return { kind: 'ambiguous', id: wanted, candidates: matches.map(observedSessionToolRow) };
  }
  return { kind: 'not-found', id: wanted };
}

// ---------------------------------------------------------------------------
// focus
// ---------------------------------------------------------------------------

export type FocusObservedResult =
  | { ok: true; via: 'frontmost' | 'open-chatgpt' }
  | {
      ok: false;
      reason: 'no-pid' | 'frontmost-failed' | 'open-failed' | 'unsupported';
      detail?: string;
    };

/** Codex Desktop threads have no tty of their own; their windows belong to
 *  ChatGPT.app, so the focus fallback is `open -a ChatGPT`. Detection keys on
 *  the correlate evidence strings (desktop-host / chat-process), which are
 *  present for both `codex-desktop` and `codex-merged` rows. */
export function hasCodexDesktopEvidence(session: ObservedSession): boolean {
  return session.clientKind === 'codex'
    && session.evidence.some(
      (entry) => entry.startsWith('desktop-host:') || entry.startsWith('chat-process '),
    );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bring the owning window to the front. TTY-backed sessions go through
 *  System Events (frontmost by unix pid); when that fails — or the session
 *  has no tty at all — Codex Desktop rows fall back to opening ChatGPT.app.
 *  Anything else is a typed failure, never an exception. */
export async function focusObservedSession(
  session: ObservedSession,
  deps: SessionActionDeps = {},
): Promise<FocusObservedResult> {
  const execImpl = deps.execImpl ?? defaultExec;
  if (session.pid === undefined) return { ok: false, reason: 'no-pid' };
  let frontmostDetail: string | undefined;
  if (session.tty) {
    try {
      // pid is a number from our own ps parse — safe to interpolate.
      await execImpl(
        'osascript',
        ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${session.pid}) to true`],
        { timeoutMs: FOCUS_TIMEOUT_MS, maxBuffer: ACTION_MAX_BUFFER },
      );
      return { ok: true, via: 'frontmost' };
    } catch (error) {
      frontmostDetail = errorDetail(error);
    }
  }
  if (hasCodexDesktopEvidence(session)) {
    try {
      await execImpl('open', ['-a', 'ChatGPT'], {
        timeoutMs: FOCUS_TIMEOUT_MS,
        maxBuffer: ACTION_MAX_BUFFER,
      });
      return { ok: true, via: 'open-chatgpt' };
    } catch (error) {
      return { ok: false, reason: 'open-failed', detail: errorDetail(error) };
    }
  }
  return session.tty
    ? { ok: false, reason: 'frontmost-failed', detail: frontmostDetail }
    : { ok: false, reason: 'unsupported' };
}

// ---------------------------------------------------------------------------
// send text
// ---------------------------------------------------------------------------

export type SendTextResult =
  | { ok: true; bytes: number }
  | {
      ok: false;
      reason:
        | 'no-pid'
        | 'no-tty'
        | 'invalid-tty'
        | 'empty-text'
        | 'rate-limited'
        | 'write-failed';
      detail?: string;
      retryAfterMs?: number;
    };

// Terminal input accepts NOTHING but printable text and newlines: tab would
// trigger shell completion, CR would submit early, ESC would inject terminal
// control sequences, and bidi/zero-width controls make the typed text look
// different from what the user approved.
const INPUT_CONTROL_CHARS =
  /[\x00-\x09\x0B-\x1F\x7F-\x9F\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Sanitize text destined for another process's terminal: strip control
 *  chars (newline excepted), cap at SEND_TEXT_MAX_CHARS, and end with exactly
 *  one trailing newline (the single Return that submits the line). Returns ''
 *  when nothing worth sending remains. */
export function sanitizeObservedInput(text: string): string {
  const stripped = text.replace(INPUT_CONTROL_CHARS, '');
  if (!stripped.trim()) return '';
  const capped = stripped.length > SEND_TEXT_MAX_CHARS
    ? stripped.slice(0, SEND_TEXT_MAX_CHARS)
    : stripped;
  return `${capped.replace(/\n+$/g, '')}\n`;
}

// ps tt values are kernel-assigned ('s003', 'console'); anything else means
// our parse was poisoned — refuse before it becomes a /dev path component.
const SAFE_TTY = /^[A-Za-z0-9]+$/;

const lastSentAtBySession = new Map<string, number>();

/** Test hook: clear the per-session rate-limit window. */
export function resetSendTextRateLimits(): void {
  lastSentAtBySession.clear();
}

/** Type text into the observed session's terminal, followed by exactly one
 *  Return. Requires a live pid AND a controlling terminal (a '??'/missing
 *  tty means there is nothing to type into — desktop threads fail here with
 *  'no-tty', and the Host should offer focus instead). Rate-limited per
 *  session so a looping agent cannot machine-gun input into a terminal. */
export async function sendTextToObservedSession(
  session: ObservedSession,
  text: string,
  deps: SessionActionDeps = {},
): Promise<SendTextResult> {
  const now = deps.now ?? Date.now;
  if (session.pid === undefined) return { ok: false, reason: 'no-pid' };
  // correlate already strips '??' rows, but the guard stays explicit here:
  // no usable controlling terminal means there is nothing to type into.
  if (!session.tty || session.tty === '??') return { ok: false, reason: 'no-tty' };
  if (!SAFE_TTY.test(session.tty)) return { ok: false, reason: 'invalid-tty' };
  const sanitized = sanitizeObservedInput(text);
  if (!sanitized) return { ok: false, reason: 'empty-text' };
  const lastSentAt = lastSentAtBySession.get(session.id) ?? Number.NEGATIVE_INFINITY;
  const retryAfterMs = SEND_TEXT_RATE_LIMIT_MS - (now() - lastSentAt);
  if (retryAfterMs > 0) return { ok: false, reason: 'rate-limited', retryAfterMs };
  const writeFileImpl = deps.writeFileImpl
    ?? ((path: string, data: string) => fs.writeFile(path, data, 'utf8'));
  try {
    await writeFileImpl(`/dev/tty${session.tty}`, sanitized);
  } catch (error) {
    return { ok: false, reason: 'write-failed', detail: errorDetail(error) };
  }
  lastSentAtBySession.set(session.id, now());
  return { ok: true, bytes: Buffer.byteLength(sanitized, 'utf8') };
}

// ---------------------------------------------------------------------------
// resolve-then-act entry point used by the Host MCP tools
// ---------------------------------------------------------------------------

export type ObservedActionOutcome =
  | { kind: 'focus'; result: FocusObservedResult }
  | { kind: 'send-text'; result: SendTextResult }
  | { kind: 'not-found'; id: string }
  | { kind: 'ambiguous'; id: string; candidates: ObservedSessionToolRow[] };

/** One tool call end to end: resolve the id inside the actionable (boardable)
 *  set, then run the requested action. Resolution failures come back as
 *  outcomes — the Host reads them and asks the user instead of guessing. */
export async function runObservedSessionAction(
  snapshot: ObservedSnapshot,
  action: { kind: 'focus'; id: string } | { kind: 'send-text'; id: string; text: string },
  deps: SessionActionDeps = {},
): Promise<ObservedActionOutcome> {
  const now = (deps.now ?? Date.now)();
  const boardable = boardableObservedSessions(snapshot.sessions, now);
  const resolution = resolveObservedSession(boardable, action.id);
  if (resolution.kind !== 'ok') return resolution;
  if (action.kind === 'focus') {
    return { kind: 'focus', result: await focusObservedSession(resolution.session, deps) };
  }
  return {
    kind: 'send-text',
    result: await sendTextToObservedSession(resolution.session, action.text, deps),
  };
}
