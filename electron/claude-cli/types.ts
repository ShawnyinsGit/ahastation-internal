// types.ts — protocol types for driving the claude CLI directly over its
// stream-json interface (`claude --output-format stream-json --verbose
// --input-format stream-json`).
//
// These mirror the subset of the retired @anthropic-ai/claude-agent-sdk types
// that AhaStation actually consumes. Message envelopes stay deliberately
// loose: the CLI owns the authoritative schema and consumers narrow via the
// `type` discriminator plus local casts.

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** User input frame written to the CLI's stdin. */
export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string | UserContentBlock[] };
  parent_tool_use_id: string | null;
  session_id?: string;
}

/** Any message frame emitted on the CLI's stdout (assistant/user/system/result). */
export type SDKMessage = {
  type: string;
  subtype?: string;
  message?: { role?: string; content?: unknown };
  session_id?: string;
  is_error?: boolean;
  result?: unknown;
  error?: unknown;
  request_id?: string;
  /** Attached by claude-session when the CLI stderr carries the real cause of
   *  a bare API error code. */
  errorDetail?: string;
  [key: string]: unknown;
};

export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };

export interface CanUseToolOptions {
  signal: AbortSignal;
  toolUseID: string;
  suggestions?: unknown;
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  agentID?: string;
}

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: CanUseToolOptions,
) => Promise<PermissionResult>;

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

export type SystemPrompt =
  | string
  | {
      type: 'preset';
      preset: 'claude_code';
      append?: string;
      excludeDynamicSections?: boolean;
    };

export interface ThinkingConfig {
  type: 'adaptive' | 'enabled' | 'disabled';
  budgetTokens?: number;
  display?: string;
}

/** Session options understood by the driver. Unknown extra keys are tolerated
 *  (callers share this bag with other backends) and ignored. */
export interface SessionOptions {
  systemPrompt?: SystemPrompt;
  model?: string;
  mcpServers?: Record<string, unknown>;
  skills?: 'all' | string[];
  settingSources?: string[];
  tools?: string[] | 'default';
  resume?: string;
  effort?: string;
  thinking?: ThinkingConfig;
  permissionMode?: PermissionMode;
  [key: string]: unknown;
}

/** Payload of the CLI's `initialize` control response. Only `account` is
 *  consumed today (auth-state detection in claude-session). */
export interface InitializationResult {
  account?: {
    apiProvider?: string;
    tokenSource?: string;
    apiKeySource?: string;
    email?: string;
    subscriptionType?: string;
    [key: string]: unknown;
  };
  session_id?: string;
  commands?: unknown;
  models?: unknown;
  agents?: unknown;
  [key: string]: unknown;
}
