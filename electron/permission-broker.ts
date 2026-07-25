// permission-broker.ts — provider-neutral permission bridge (Phase 2 PR②).
//
// Sits between a backend adapter (today: OpenCode) and the meeting's
// permission surfaces. Decision flow (§2.2 rules 2/3):
//   1. safe tool + auto-approve scope allows → auto-allow ('once')
//   2. destructive tool → native OS confirmation (nativeConfirmDestructive) —
//      a compromised renderer cannot fake it. With no confirmer wired, the
//      documented degrade path kicks in: the ordinary meeting-UI card.
//   3. everything else → meeting UI approval card (same pendingPermission
//      flow as the existing Claude/kimi permission-requests)
// fail-closed (rule 2): a request unanswered within the timeout (default
// 120s) is explicitly denied + the UI card withdrawn; rejectAll() on session
// end / host removal / app quit auto-denies everything pending.
//
// Value domains: UI 'allow'/'deny' → opencode 'once'/'reject'. 'always' is
// deliberately NOT exposed (its server-side lifecycle is unverified — spike
// §7). permission.replied from ANY end withdraws the request idempotently.
//
// Electron-free: timers and the risk classifier are injectable, so the whole
// decision core is unit-testable under plain node.

import { classifyToolRisk, type AutoApproveScope, type ToolRisk } from './auto-approve-policy.js';
import type { BackendSessionEvent } from './backends/cli-backend.js';
import type { PermissionNormalizationResult } from './backends/canonical-execution.js';
import type { TaskAuthorityGrant } from './task-collaboration.js';
import {
  evaluateTaskAuthority,
  summarizeCanonicalRequest,
  type AuthorityDecision,
} from './task-authority.js';

export interface CanonicalPermissionDecision {
  decision: AuthorityDecision;
  safeInput: Record<string, unknown>;
}

export interface PermissionDecisionIdentity {
  backendId: string;
  taskId: string;
  attempt: number;
  nativeRequestId: string;
  toolName?: string;
}

export function decideTaskPermission(
  normalized: PermissionNormalizationResult,
  grant: TaskAuthorityGrant | undefined,
  now = Date.now(),
  identity?: PermissionDecisionIdentity,
): CanonicalPermissionDecision {
  if (!normalized.ok) {
    return {
      decision: {
        kind: 'ask-user',
        reason: `native-request:${normalized.diagnostic}`,
      },
      // Opaque / unsupported native payloads still escalate to the user, but the
      // durable decision must retain Backend identity so release gates can prove
      // that the bridge produced a Backend-scoped canonical journal entry.
      safeInput: {
        ...(identity ? {
          backendId: identity.backendId,
          taskId: identity.taskId,
          attempt: identity.attempt,
          nativeRequestId: identity.nativeRequestId,
          ...(identity.toolName ? { toolName: identity.toolName } : {}),
        } : {}),
        normalizationDiagnostic: normalized.diagnostic,
        requiresUser: true,
      },
    };
  }
  if (!grant) {
    return {
      decision: { kind: 'deny', reason: 'task-authority-missing' },
      safeInput: summarizeCanonicalRequest(normalized.request),
    };
  }
  return {
    decision: evaluateTaskAuthority(grant, normalized.request, now),
    safeInput: summarizeCanonicalRequest(normalized.request),
  };
}

// ── OpenCode tool-name → risk mapping ───────────────────────────────────────
// OpenCode built-in tools are lowercase; map them onto the Claude-style
// names auto-approve-policy already classifies. Anything unmapped falls
// through to the policy's fail-safe: unknown tool → destructive.

export const OPENCODE_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  todowrite: 'TodoWrite',
};

export function mapOpenCodeToolName(toolName: string): string {
  return OPENCODE_TOOL_NAME_MAP[toolName.toLowerCase()] ?? toolName;
}

export function classifyOpenCodeToolRisk(toolName: string): ToolRisk {
  return classifyToolRisk(mapOpenCodeToolName(toolName));
}

// ── Value-domain mapping ────────────────────────────────────────────────────

export type UiPermissionDecision = 'allow' | 'deny';
export type OpencodePermissionResponse = 'once' | 'reject';

export function mapUiDecisionToOpencode(decision: UiPermissionDecision): OpencodePermissionResponse {
  return decision === 'allow' ? 'once' : 'reject';
}

// ── Broker ──────────────────────────────────────────────────────────────────

export interface BrokerPermissionRequest {
  /** Provider-native permission id (opencode permissionID). */
  id: string;
  backendId: string;
  hostId?: string;
  /** Provider-native session id (opencode sessionID) — the reply endpoint
   *  is addressed per session. */
  sessionID: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
}

export type BrokerDecisionReason = 'auto-approve' | 'native-confirm' | 'ui' | 'timeout' | 'shutdown';

export const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

export interface PermissionBrokerOptions {
  getAutoApproveScope: () => AutoApproveScope;
  /** Deliver the final answer to the provider (fire-and-forget; delivery
   *  failures are the adapter's to log — the fail-closed answer stands). */
  reply: (
    request: BrokerPermissionRequest,
    response: OpencodePermissionResponse,
    reason: BrokerDecisionReason,
  ) => void;
  /** Forward a meeting-visible event (permission-request card, card
   *  withdrawal, timeout notice). The adapter's own emit, in practice. */
  emitToMeeting: (event: BackendSessionEvent) => void;
  /** Native OS confirmer for destructive tools. Optional — when absent,
   *  destructive requests degrade to the meeting-UI card (same degrade path
   *  as the existing Claude session). */
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  /** Injectable risk classifier (tests). Defaults to the opencode mapping. */
  classify?: (toolName: string) => ToolRisk;
  timeoutMs?: number;
  /** Injectable timers (tests). */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

interface PendingEntry {
  request: BrokerPermissionRequest;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PermissionBroker {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly opts: PermissionBrokerOptions) {}

  get size(): number {
    return this.pending.size;
  }

  has(id: string): boolean {
    return this.pending.has(id);
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Feed a provider permission request. Applies the decision flow; safe
   *  auto-allow answers immediately and never becomes pending. */
  async submit(request: BrokerPermissionRequest): Promise<void> {
    if (this.pending.has(request.id)) return; // idempotent re-delivery
    const classify = this.opts.classify ?? classifyOpenCodeToolRisk;
    const risk = classify(request.toolName);
    const scope = this.opts.getAutoApproveScope();

    if (risk === 'safe' && scope !== 'off') {
      this.opts.reply(request, 'once', 'auto-approve');
      return;
    }

    if (risk === 'destructive' && this.opts.confirmDestructive) {
      // Native OS dialog. Tracked (no UI card) so shutdown/replied can still
      // resolve it; the answer lands whenever the user decides.
      this.track(request);
      try {
        const allowed = await this.opts.confirmDestructive(request.toolName, request.input);
        if (!this.pending.has(request.id)) return; // resolved externally meanwhile
        this.opts.reply(request, allowed ? 'once' : 'reject', 'native-confirm');
      } finally {
        this.untrack(request.id);
      }
      return;
    }

    // Meeting-UI approval card.
    this.track(request);
    this.opts.emitToMeeting({
      kind: 'permission-request',
      id: request.id,
      toolName: request.toolName,
      input: request.input,
      toolUseID: request.id,
    });
  }

  /** A UI decision came back through the broadcast resolvePermission chain.
   *  Every session's adapter gets the call — only the one holding the id
   *  acts; anything else is a no-op (broadcast mismatch). */
  resolveUi(id: string, decision: UiPermissionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.untrack(id);
    this.opts.reply(entry.request, mapUiDecisionToOpencode(decision), 'ui');
    return true;
  }

  /** The provider reports the request was replied — from ANY end (our own
   *  reply echoes back too). Idempotent: unknown ids no-op. */
  cancelExternal(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.untrack(id);
    // Withdraw the meeting-UI card (if any) so the two ends stay in sync.
    this.opts.emitToMeeting({ kind: 'permission-cancelled', id });
    return true;
  }

  /** Deny everything still pending — session end / host removal / app quit.
   *  Returns the number of requests rejected. */
  rejectAll(reason: 'timeout' | 'shutdown' = 'shutdown'): number {
    const entries = [...this.pending.values()];
    for (const entry of entries) {
      this.untrack(entry.request.id);
      this.opts.reply(entry.request, 'reject', reason);
    }
    return entries.length;
  }

  private track(request: BrokerPermissionRequest): void {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    const setT = this.opts.setTimeoutFn ?? setTimeout;
    const entry: PendingEntry = { request, timer: null };
    entry.timer = setT(() => {
      // fail-closed: unanswered within the window → explicit deny + UI hint.
      if (!this.pending.delete(request.id)) return;
      this.opts.reply(request, 'reject', 'timeout');
      this.opts.emitToMeeting({ kind: 'permission-cancelled', id: request.id });
      this.opts.emitToMeeting({
        kind: 'message',
        message: {
          type: 'system',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `权限请求超时（${Math.round(timeoutMs / 1000)}s），已自动拒绝：${request.toolName}`,
              },
            ],
          },
        },
      });
    }, timeoutMs);
    this.pending.set(request.id, entry);
  }

  private untrack(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.timer !== null) {
      (this.opts.clearTimeoutFn ?? clearTimeout)(entry.timer);
    }
    this.pending.delete(id);
  }
}
