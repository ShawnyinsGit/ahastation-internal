// host-group.ts — one Host agent + its WorkerScheduler.
//
// Encapsulates the per-backend pair (host session, worker pool) so the
// Orchestrator can manage M HostGroups in a single meeting. Each HostGroup
// is tied to one CLI backend (Claude Code, Codex, Kimi, etc.) and runs its
// own talker (the "host") and its own set of workers.
//
// The orchestrator keeps shared state (decisions, memory, recap, transcript)
// and coordinates between HostGroups. The HostGroup owns only the live
// sessions and their per-worker mechanics.
//
// Backward compatibility: when there is only one HostGroup with id='default',
// the system behaves identically to the pre-multi-host architecture.

import { ClaudeSession, type SessionEvent } from './claude-session.js';
import type { BackendSession } from './backends/cli-backend.js';
import type {
  NativePermissionRequest,
  PermissionNormalizationResult,
} from './backends/canonical-execution.js';
import type { AutoApproveScope } from './auto-approve-policy.js';
import type { BrowserTabManager } from './browser-tab-manager.js';
import {
  buildTalkerMcp,
  buildWorkerMcp,
  type OrchestratorBridge,
} from './meeting-mcp.js';
import { buildComputerUseMcp, type ComputerUseBridge } from './computer-use-mcp.js';
import { buildBrowserMcp, type BrowserMcpBridge } from './browser-mcp.js';
import { WorkerScheduler, type SessionFactory } from './worker-scheduler.js';
import {
  TALKER_PROMPT,
  COORDINATOR_ROLE_PROMPT,
  EXPERT_ROLE_PROMPT,
  REPORT_MODE_SUFFIX,
} from './orchestrator-prompts.js';
import {
  formatForPrompt,
  selectRelevant,
} from './memory.js';
import { getSettings } from './store.js';
import {
  MEMORY_TOKEN_BUDGET,
  TALKER_TRANSCRIPT_MAX_ENTRIES,
  extractText,
} from './orchestrator-helpers.js';
import type {
  OrchestratorEvent,
  TalkerTurn,
} from './orchestrator-types.js';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TaskWorkspaceManager } from './task-workspace.js';
import type { DeliveryHarness } from './delivery-harness.js';
import type {
  AuthorizedMeetingContextSource,
  ContextSelection,
} from './task-context.js';
import type { ContextPackage, TaskAuthorityGrant } from './task-collaboration.js';
import type {
  BackendEffectiveProfile,
  TaskExecutionProfile,
} from './task-collaboration.js';
import type { BackendRuntime } from './backends/task-profile.js';
import type { PlanMeetingTask } from './meeting-tools.js';

export interface HostGroupOpts {
  /** Unique identifier for this host group. Default = 'default'. */
  id: string;
  /** Backend identifier (e.g. 'claude-code', 'codex', 'kimi', 'qoder'). */
  backendId: string;
  /** Emit channel — should be the orchestrator's safeEmit wrapper. */
  emit: (e: OrchestratorEvent) => void;
  /** Shared workspace cwd. */
  cwd: string;
  /** Project ID for memory lookups. */
  projectId: string;
  autoApproveScope: AutoApproveScope;
  workerEnv?: NodeJS.ProcessEnv;
  talkerModel?: string;
  confirmDestructive?: (toolName: string, input: Record<string, unknown>) => Promise<boolean>;
  sessionFactory: SessionFactory;
  resolveWorkerSessionFactory?: (backendId?: string) => SessionFactory;
  browserTabManager?: BrowserTabManager;
  /** Bridge to the orchestrator for MCP tool callbacks. */
  bridge: OrchestratorBridge;
  /** Reports orchestrator shutdown. */
  isClosed: () => boolean;
  /** Live read of speech filter mode. */
  getSpeechFilterMode: () => 'strict' | 'off';
  isCoordinator: () => boolean;
  workspaceManager?: TaskWorkspaceManager;
  meetingId: string;
  deliveryHarness: DeliveryHarness;
  deliveryArtifactRoot?: string;
  flushEvents?: () => Promise<void>;
  initialPlanVersion?: number;
  getAuthorizedTaskContextSource: (
    taskId: string,
    selection: ContextSelection,
  ) => Promise<AuthorizedMeetingContextSource>;
  persistContextPackage: (contextPackage: ContextPackage) => Promise<void>;
  compileTaskProfile?: (
    requested: TaskExecutionProfile,
  ) => Promise<{
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }>;
  persistTaskProfile?: (input: {
    taskId: string;
    attempt: number;
    requestedProfile: TaskExecutionProfile;
    runtime: BackendRuntime;
    effectiveProfile: BackendEffectiveProfile;
  }) => Promise<void>;
  taskProfileCompilerRequired?: boolean;
  compileTaskAuthority?: (input: {
    taskId: string;
    attempt: number;
    planVersion: number;
    approvalDecisionId: string;
    workspaceRoot: string;
    authorityRequest: PlanMeetingTask['authorityRequest'];
    approvedAt: number;
  }) => TaskAuthorityGrant;
  persistTaskAuthority?: (input: {
    taskId: string;
    attempt: number;
    authorityGrant: TaskAuthorityGrant;
  }) => Promise<void>;
  normalizePermissionRequest?: (
    backendId: string,
    native: NativePermissionRequest,
  ) => PermissionNormalizationResult;
  persistPermissionDecision?: (input: {
    taskId: string;
    attempt: number;
    nativeRequestId: string;
    decision: 'allow' | 'ask-user' | 'deny';
    reason: string;
    safeInput: Record<string, unknown>;
    grantHash?: string;
  }) => Promise<void>;
  taskAuthorityCompilerRequired?: boolean;
}

export class HostGroup {
  readonly id: string;
  readonly backendId: string;

  private host: BackendSession | null = null;
  private ready = false;
  private suppressUnexpectedHostEnd = false;
  private scheduler: WorkerScheduler;
  private emit: (e: OrchestratorEvent) => void;
  private cwd: string;
  private projectId: string;
  private autoApproveScope: AutoApproveScope;
  private workerEnv: NodeJS.ProcessEnv | undefined;
  private talkerModel: string | undefined;
  private confirmDestructive: ((toolName: string, input: Record<string, unknown>) => Promise<boolean>) | undefined;
  private sessionFactory: SessionFactory;
  private browserTabManager: BrowserTabManager | undefined;
  private bridge: OrchestratorBridge;
  private isClosed: () => boolean;
  private getSpeechFilterMode: () => 'strict' | 'off';
  private isCoordinator: () => boolean;

  /** Talker transcript for recap. Accumulates user+assistant text turns. */
  private talkerTranscript: TalkerTurn[] = [];
  private talkerTurnSeq = 0;

  constructor(opts: HostGroupOpts) {
    this.id = opts.id;
    this.backendId = opts.backendId;
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.projectId = opts.projectId;
    this.autoApproveScope = opts.autoApproveScope;
    this.workerEnv = opts.workerEnv;
    this.talkerModel = opts.talkerModel;
    this.confirmDestructive = opts.confirmDestructive;
    this.sessionFactory = opts.sessionFactory;
    this.browserTabManager = opts.browserTabManager;
    this.bridge = opts.bridge;
    this.isClosed = opts.isClosed;
    this.getSpeechFilterMode = opts.getSpeechFilterMode;
    this.isCoordinator = opts.isCoordinator;

    const cuBridge: ComputerUseBridge = {
      injectScreenshot: (workerId, data) => {
        this.scheduler.injectScreenshotToWorker(workerId, data);
      },
    };
    const browserBridge: BrowserMcpBridge = {
      injectScreenshot: (workerId, data) => {
        this.scheduler.injectScreenshotToWorker(workerId, data);
      },
    };

    this.scheduler = new WorkerScheduler({
      emit: (e) => this.taggedEmit(e),
      cwd: this.cwd,
      autoApproveScope: this.autoApproveScope,
      workerEnv: this.workerEnv,
      confirmDestructive: this.confirmDestructive,
      sessionFactory: this.sessionFactory,
      resolveSessionFactory: opts.resolveWorkerSessionFactory,
      workspaceManager: opts.workspaceManager,
      meetingId: opts.meetingId,
      defaultBackendId: opts.backendId,
      deliveryHarness: opts.deliveryHarness,
      deliveryArtifactRoot: opts.deliveryArtifactRoot,
      flushEvents: opts.flushEvents,
      initialPlanVersion: opts.initialPlanVersion,
      getAuthorizedTaskContextSource: opts.getAuthorizedTaskContextSource,
      persistContextPackage: opts.persistContextPackage,
      contextCompilerRequired: true,
      compileTaskProfile: opts.compileTaskProfile,
      persistTaskProfile: opts.persistTaskProfile,
      taskProfileCompilerRequired: opts.taskProfileCompilerRequired,
      compileTaskAuthority: opts.compileTaskAuthority,
      persistTaskAuthority: opts.persistTaskAuthority,
      normalizePermissionRequest: opts.normalizePermissionRequest,
      persistPermissionDecision: opts.persistPermissionDecision,
      taskAuthorityCompilerRequired: opts.taskAuthorityCompilerRequired,
      buildWorkerMcp: (workerId) => buildWorkerMcp(this.bridge, workerId, this.cwd),
      buildComputerUseMcp: process.platform === 'darwin'
        ? (workerId) => buildComputerUseMcp(cuBridge, workerId)
        : undefined,
      buildBrowserMcp: this.browserTabManager
        ? (workerId) => buildBrowserMcp(this.browserTabManager!, browserBridge, workerId)
        : undefined,
      getTalker: () => this.host,
      isClosed: this.isClosed,
      getSpeechFilterMode: this.getSpeechFilterMode,
    });
  }

  /** Emit an event tagged with this HostGroup's id. */
  private taggedEmit(e: OrchestratorEvent) {
    // The OrchestratorEvent shape gets a hostId field added in this phase.
    // For now, emit as-is — the orchestrator's wrapper adds hostId.
    this.emit(e);
  }

  getHost(): BackendSession | null {
    return this.host;
  }

  isReady(): boolean {
    return this.ready && this.host !== null;
  }

  getScheduler(): WorkerScheduler {
    return this.scheduler;
  }

  getTranscript(): TalkerTurn[] {
    return [...this.talkerTranscript];
  }

  setAutoApproveScope(scope: AutoApproveScope) {
    this.autoApproveScope = scope;
    this.host?.setAutoApproveScope?.(scope);
    this.scheduler.setAutoApproveScope(scope);
  }

  async start(greeting?: string) {
    this.ready = false;
    const meetingMcp = buildTalkerMcp(this.bridge, this.isCoordinator, this.id);

    const rolePrompt = this.isCoordinator() ? COORDINATOR_ROLE_PROMPT : EXPERT_ROLE_PROMPT;
    let systemPrompt: string = TALKER_PROMPT + rolePrompt;
    try {
      const memoryEntries = await selectRelevant(this.projectId, {
        tokenBudget: MEMORY_TOKEN_BUDGET,
      });
      const memoryBlock = formatForPrompt(memoryEntries);
      if (memoryBlock) {
        systemPrompt = `## 历史记忆 (从过往会议沉淀)\n\n${memoryBlock}\n\n---\n\n${TALKER_PROMPT}${rolePrompt}`;
      }
    } catch (err) {
      console.warn('[host-group] failed to load memory for system prompt:', err);
    }

    // Append report-mode instructions when the user enabled 汇报模式. The
    // talker's save_document tool is always available (no cost when unused),
    // but the prompt suffix is what makes it actually use the tool for long
    // responses instead of reading everything aloud.
    if (getSettings().reportModeEnabled) {
      systemPrompt += '\n' + REPORT_MODE_SUFFIX;
    }

    this.host = this.sessionFactory({
      cwd: this.cwd,
      autoApproveScope: this.autoApproveScope,
      envOverride: this.workerEnv,
      confirmDestructive: this.confirmDestructive,
      emit: (e) => this.onHostEvent(e),
      sessionOptions: {
        systemPrompt,
        tools: [],
        mcpServers: { meeting: meetingMcp },
        skills: [],
        settingSources: [],
        model: this.talkerModel ?? 'claude-haiku-4-5',
        includePartialMessages: true,
      },
    });

    await this.host.start();

    // The session may have been torn down while its handshake promise was
    // settling. A missing host is a failed readiness transition, never Ready.
    if (!this.host) {
      throw new Error(`backend '${this.backendId}' ended before readiness`);
    }
    if (greeting) {
      this.ready = true;
      this.host.sendUserText(greeting, 'normal');
    } else {
      this.ready = true;
    }
  }

  sendUserText(text: string) {
    this.host?.sendUserText(text, 'high');
  }

  sendUserImage(content: SDKUserMessage['message']['content']) {
    this.host?.sendUserContent(
      content as string | import('./backends/cli-backend.js').UserContentBlock[],
      'high',
    );
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', message?: string) {
    this.host?.resolvePermission(id, decision, message);
    this.scheduler.resolvePermissionInAny(id, decision, message);
  }

  async interrupt() {
    const tasks: Promise<void>[] = [];
    if (this.host) tasks.push(this.host.interrupt());
    for (const t of this.scheduler.interruptAll()) tasks.push(t);
    await Promise.allSettled(tasks);
  }

  async setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') {
    const tasks: Promise<void>[] = [];
    if (this.host?.setPermissionMode) tasks.push(this.host.setPermissionMode(mode));
    for (const t of this.scheduler.setPermissionModeAll(mode)) tasks.push(t);
    await Promise.allSettled(tasks);
  }

  /** Tear down host + workers. Returns the final buffered worker lines. */
  end(): string[] {
    // Scheduler always exists (set in constructor) and may have live workers
    // even when host is null (e.g. tests that spawn workers directly).
    const finalLines = this.scheduler.collectFinalBufferedLines();
    this.scheduler.endAll();
    this.host?.end();
    this.host = null;
    this.ready = false;
    return finalLines;
  }

  /** Returns true if the host session died unexpectedly (not from our end()). */
  isHostAlive(): boolean {
    return this.host !== null;
  }

  private onHostEvent(e: SessionEvent) {
    if (e.kind === 'auth-required') {
      // Authentication failure is an intentional circuit-breaker, not a
      // subprocess crash. Stop routing new turns and preserve existing workers.
      this.suppressUnexpectedHostEnd = true;
      this.host?.end();
      this.host = null;
      this.taggedEmit({ source: 'talker', event: e });
      return;
    }
    if (e.kind === 'ended') {
      this.host = null;
      this.ready = false;
    }
    this.taggedEmit({ source: 'talker', event: e });

    if (e.kind === 'ended' && this.suppressUnexpectedHostEnd) {
      this.suppressUnexpectedHostEnd = false;
      return;
    }

    if (e.kind === 'ended' && !this.isClosed()) {
      this.taggedEmit({
        source: 'talker',
        event: {
          kind: 'message',
          message: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{
                type: 'text',
                text: `（Host [${this.id}] 进程意外退出，该主持的会议部分自动结束。）`,
              }],
            },
            parent_tool_use_id: null,
            session_id: `host-group-${this.id}-exit`,
          } as unknown as SDKMessage,
        },
      });
      return;
    }

    if (e.kind === 'message') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg: any = e.message;
      const t = msg?.type;
      if (t === 'assistant') {
        const text = extractText(msg);
        if (text) this.appendTurn({ role: 'assistant', text });
      } else if (t === 'user') {
        const text = extractText(msg);
        if (text) this.appendTurn({ role: 'user', text });
      }
    }
  }

  private appendTurn(turn: Pick<TalkerTurn, 'role' | 'text'>) {
    this.talkerTurnSeq += 1;
    this.talkerTranscript = [...this.talkerTranscript, {
      ...turn,
      id: `${this.id}:turn:${this.talkerTurnSeq}`,
      timestamp: Date.now(),
    }].slice(
      -TALKER_TRANSCRIPT_MAX_ENTRIES,
    );
  }
}
