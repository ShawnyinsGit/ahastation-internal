// types.ts — shared contracts for the read-only observation layer.
//
// The observation layer discovers externally-launched AI CLI sessions
// (S0: Claude Code + Codex CLI) from process scans and client state files.
// Everything here is inferred from read-only evidence; nothing is written
// back to the clients' directories (TD-7).

export type ClientKind = 'claude-code' | 'codex';

/** One row of the shared `ps` snapshot for a process that matched a client
 * binary name. `command` is the full args column (untruncated). */
export interface ObservedProcessSignal {
  pid: number;
  ppid: number;
  command: string;
  cpuPct: number;
  rssKb: number;
  cwd?: string;
}

/** Claude-specific signals extracted from the transcript tail window. */
export interface ClaudeTailSignals {
  kind: 'claude';
  /** Last real (non-synthetic) user line has no assistant line after it. */
  trailingRealUser: boolean;
  /** Last assistant tool_use has no matching tool_result later in the tail. */
  unclosedToolUse: boolean;
  /** user+assistant lines seen in the scanned head+tail windows. */
  messagesSeen: number;
  /** First real user prompt text (title candidate, unredacted). */
  firstPromptTitle?: string;
  /** type:"summary" line text (title candidate, unredacted). */
  summaryTitle?: string;
  gitBranch?: string;
}

/** Codex-specific signals extracted from the rollout tail window. */
export interface CodexTailSignals {
  kind: 'codex';
  /** event_msg/user_message seen with no later agent_message/task_complete. */
  generating: boolean;
  /** function_call entries without a paired function_call_output. */
  pendingFunctionCalls: number;
  sawTaskComplete: boolean;
  /** Heuristic: session_meta.source === 'exec' (one-shot `codex exec`). */
  isExec: boolean;
  turnCount: number;
}

export type TailSignals = ClaudeTailSignals | CodexTailSignals;

/** Evidence gathered from one client state file (transcript / rollout). */
export interface ObservedFileSignal {
  clientKind: ClientKind;
  nativeSessionId: string;
  cwd: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
  /** Client-specific title (Codex: session_index / global-state thread title). */
  title?: string;
  /** Provenance of `title` when set by the parser (Codex only). */
  titleSource?: ObservedTitleSource;
  model?: string;
  tailSignals: TailSignals;
}

export type ObservedState = 'active' | 'waiting' | 'idle' | 'done' | 'unknown';
export type ObservedActivity = 'thinking' | 'executing' | 'waiting' | 'unknown';

export type ObservedTitleSource =
  | 'global-state'
  | 'session-index'
  | 'first-prompt'
  | 'summary'
  | 'project-fallback';

/** One observed session, merged from process + file signals. */
export interface ObservedSession {
  /** sha1(clientKind + nativeSessionId + realpath(cwd)) — stable identity. */
  id: string;
  clientKind: ClientKind;
  nativeSessionId: string;
  /** sha1(realpath(cwd)) — matches the orchestration project grouping. */
  projectId: string;
  projectName: string;
  cwd: string;
  /** Display title, redacted + control-char stripped. Never a raw path. */
  title: string;
  state: ObservedState;
  activity: ObservedActivity;
  /** Always true: every state here is inferred, never reported by the client. */
  inferred: true;
  model?: string;
  lastActiveAt: number;
  pid?: number;
  titleSource: ObservedTitleSource;
  isNoise: boolean;
  /** Human-readable provenance notes (which signals produced this row). */
  evidence: string[];
}

export interface ObservedSnapshot {
  sessions: ObservedSession[];
  scannedAt: number;
}

/** Injected at service start; any match excludes a process/session. */
export interface SelfExclusion {
  pids: Set<number>;
  sessionIds: Set<string>;
}
