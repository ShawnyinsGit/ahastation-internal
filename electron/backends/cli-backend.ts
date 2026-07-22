// cli-backend.ts — universal adapter interface for CLI backend plugins.
//
// Every CLI backend (Claude Code, Codex, Kimi, Qoder) implements `CliBackend`
// to create sessions that satisfy the `BackendSession` contract. The
// `NormalizedMessage` type mirrors the Claude SDK's `SDKMessage` shape closely
// enough that the existing `extractText()` / `extractToolUses()` helpers in
// `orchestrator-helpers.ts` work without modification — they access
// `message?.message?.content` and look for `{ type: 'text', text }` and
// `{ type: 'tool_use', name, input }` content blocks.
//
// Each adapter translates its CLI's native message format into this normalized
// shape at the boundary. The `Orchestrator` and `WorkerScheduler` consume
// `BackendSession` + `NormalizedMessage` instead of Claude-specific types.

import type { AutoApproveScope } from '../auto-approve-policy.js';

// ── Input priority ────────────────────────────────────────────────────────────
// Re-exported from claude-session semantics: high = user, normal = system,
// low = worker updates. Every backend must honour this ordering.
export type InputPriority = 'high' | 'normal' | 'low';

// ── Normalized content blocks ─────────────────────────────────────────────────
// Matches the Anthropic Messages API content block format that the renderer
// and orchestrator-helpers already consume.

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolUseContentBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | string;
    data: string;
  };
}

export type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock
  | ImageContentBlock;

// ── Normalized message ─────────────────────────────────────────────────────────
// The universal message shape emitted by all backends. Structured to be
// compatible with `SDKMessage` access patterns: `msg.message.content`.
//
// The `type` field mirrors SDK message types: 'assistant' for model responses,
// 'user' for user input echoes, 'result' for final results, 'system' for
// system messages. Backends map their native types to these categories.

export interface NormalizedMessage {
  /** SDKMessage-compatible type discriminator. */
  type: 'assistant' | 'user' | 'result' | 'system';
  /**
   * Anthropic-shaped message body. This is what `extractText()` and
   * `extractToolUses()` read. Adapters MUST populate this for assistant
   * messages so the orchestrator's existing helpers work.
   */
  message?: {
    role?: 'assistant' | 'user';
    content?: ContentBlock[] | string;
  };
  /** Error code for error messages. */
  errorCode?: string;
  /** Human-readable error detail (e.g. stderr ring). */
  errorDetail?: string;
  /** Request ID for debugging. */
  requestId?: string;
  /** Backend-specific raw payload. */
  raw?: unknown;
}

// ── Session events ─────────────────────────────────────────────────────────────
// Mirrors `SessionEvent` from claude-session.ts so the orchestrator's event
// handling stays unchanged.

export type BackendSessionEvent =
  | { kind: 'message'; message: NormalizedMessage }
  | { kind: 'permission-request'; id: string; toolName: string; input: Record<string, unknown>; toolUseID: string }
  | { kind: 'permission-cancelled'; id: string }
  | { kind: 'auth-required'; error: string }
  | { kind: 'error'; error: string }
  | { kind: 'ended' };

// ── User message input ────────────────────────────────────────────────────────
// Structured user input that backends accept. Text-only or content blocks
// (text + images).

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

// ── Session configuration ──────────────────────────────────────────────────────
// Passed to `CliBackend.createSession()` to configure a new session.

export interface BackendSessionConfig {
  /** Working directory for the session. */
  cwd: string;
  /** System prompt / instructions for the agent. */
  systemPrompt?: string;
  /** Model identifier (backend-specific, e.g. 'claude-haiku-4-5', 'o3-pro'). */
  model?: string;
  /** Process environment variables for the subprocess. */
  env?: NodeJS.ProcessEnv;
  /** MCP server configurations to mount into the session. */
  mcpServers?: Record<string, unknown>;
  /** Skills to enable ('all' or specific skill names). */
  skills?: 'all' | string[];
  /** Auto-approve scope for tool permissions. */
  autoApproveScope?: AutoApproveScope;
  /** Backend-specific opaque options. */
  extra?: Record<string, unknown>;
  /** Native backend session/thread id restored from a Meeting snapshot. */
  resumeSessionId?: string;
  /** Least-privilege execution profile selected by the meeting scheduler. */
  executionRole?: 'host' | 'worker';
  /** Native OS confirmer for destructive tool calls (PermissionBroker). When
   *  absent, destructive requests degrade to the meeting-UI approval card. */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Meeting host this session belongs to (set by the orchestrator backend
   *  bridge). Adapters use it for hostId-keyed fan-out (editor windows). */
  hostId?: string;
}

export interface BackendSessionSnapshot {
  protocol: string;
  sessionId: string;
  protocolVersion?: string;
  backendVersion?: string;
}

// ── Auth configuration ────────────────────────────────────────────────────────
// Per-backend auth settings. Stored encrypted in settings.json.

export interface BackendAuthConfig {
  /** Auth mode: 'apikey' (env var), 'oauth' (CLI login), 'none' (no auth needed). */
  authMode: 'apikey' | 'oauth' | 'none';
  /** Encrypted API key (safeStorage). Decrypted in memory only. */
  apiKey?: string;
  /** Base URL for the API (e.g. custom gateway). */
  baseUrl?: string;
  /** Model override for this backend. */
  model?: string;
}

// ── Backend capabilities ──────────────────────────────────────────────────────
// Declares what features a backend supports. The orchestrator checks these
// before using features (e.g. no permission flow for backends that don't
// support it).

export interface BackendCapabilities {
  /** Whether this backend may own the meeting Coordinator role. */
  coordinate: boolean;
  /** Whether this backend can complete the current Delivery Worker contract. */
  executeTasks: boolean;
  /** Display name for UI (e.g. "Claude Code", "Codex", "Kimi"). */
  displayName: string;
  /** Icon identifier for UI rendering. */
  iconId: string;
  /** Whether this backend supports MCP server mounting. */
  mcp: boolean;
  /** Whether this backend supports tool permission flow (canUseTool). */
  permissions: boolean;
  /** Whether this backend supports system prompts. */
  systemPrompt: boolean;
  /** Whether this backend supports skills/agents directory. */
  skills: boolean;
  /** Whether this backend supports interrupt mid-stream. */
  interrupt: boolean;
  /** Default model for this backend. */
  defaultModel?: string;
  /** Available models (if known). */
  models?: string[];
  /** npm package name that provides the CLI binary. */
  npmPackage?: string;
  /** Installation command hint for "not installed" UI. */
  installHint?: string;
}

// ── Backend session handle ─────────────────────────────────────────────────────
// Returned by `CliBackend.createSession()`. The orchestrator uses this to
// control the session lifecycle.

export interface BackendSession {
  /** Start the session. Begins streaming events via the emit callback. */
  start(): Promise<void>;
  /** End the session. Releases all resources. Idempotent. */
  end(): void;
  /** Send a text message from the user. */
  sendUserText(text: string, priority?: InputPriority): void;
  /** Send structured content (text + images) from the user. */
  sendUserContent(content: string | UserContentBlock[], priority?: InputPriority): void;
  /** Resolve a pending tool permission request. */
  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string): void;
  /** Interrupt the current generation/stream. */
  interrupt(): Promise<void>;
  /** Set the auto-approve scope for tool permissions. */
  setAutoApproveScope?(scope: AutoApproveScope): void;
  /** Set the permission mode (backend-specific). */
  setPermissionMode?(mode: string): Promise<void>;
  /** Durable native handle used for interrupted recovery. */
  snapshot?(): BackendSessionSnapshot | null;
}

// ── CLI backend factory ────────────────────────────────────────────────────────
// Each backend implements this interface. The registry holds all registered
// backends and provides them to the orchestrator on session creation.

export interface CliBackend {
  /** Unique backend identifier. */
  readonly id: string;
  /** Backend capabilities and metadata. */
  readonly capabilities: BackendCapabilities;

  /**
   * Create a new session. The backend spawns a subprocess (or connects to an
   * SDK) and begins streaming events via the `emit` callback after `start()`
   * is called on the returned handle.
   */
  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession;

  /**
   * Resolve the CLI binary path for this backend. Returns null if the CLI
   * is not installed or cannot be found. Used by the registry to determine
   * which backends are available.
   */
  resolveBinary(): string | null;

  /**
   * Build the subprocess environment for this backend, merging the auth
   * config with any extra environment variables.
   */
  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  /**
   * Validate that the auth configuration is correct and the backend can
   * authenticate. Returns ok: true if auth is valid.
   */
  validateAuth?(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }>;

  /**
   * Trigger an OAuth login flow for backends that support it. Opens a
   * browser or runs a CLI command to authenticate.
   */
  loginOAuth?(): Promise<{ ok: boolean; error?: string }>;

  /**
   * Check whether the backend is currently authenticated (for OAuth backends).
   */
  checkAuthStatus?(): Promise<{ loggedIn: boolean }>;
}
