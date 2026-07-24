// codex-adapter.ts — OpenAI Codex CLI backend adapter.
//
// Uses @openai/codex-sdk (TypeScript SDK wrapping the Rust codex CLI).
// The SDK spawns the CLI subprocess internally and exchanges JSONL events
// over stdin/stdout.
//
// SDK API:
//   const codex = new Codex({ apiKey, baseUrl, env });
//   const thread = codex.startThread();
//   const { events } = await thread.runStreamed(prompt, threadOptions);
//
// Events: thread.started, turn.started, turn.completed, turn.failed,
//         item.started, item.updated, item.completed
//
// Items: AgentMessageItem, ReasoningItem, CommandExecutionItem,
//        FileChangeItem, McpToolCallItem, WebSearchItem, TodoListItem,
//        ErrorItem
//
// Auth: apiKey in CodexOptions or OPENAI_API_KEY env var.
//       Also supports `codex auth login` for ChatGPT Plus/Pro OAuth.

import { execFileSync, spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BackendSession,
  BackendSessionConfig,
  BackendSessionEvent,
  BackendAuthConfig,
  BackendCapabilities,
  CliBackend,
  InputPriority,
  NormalizedMessage,
  UserContentBlock,
  ContentBlock,
} from './cli-backend.js';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import { runTerminalLogin } from './terminal-login.js';
import { isolatedSubprocessEnv } from './backend-environment.js';
import {
  CodexAppServerTransport,
  extractCodexRuntimeVersion,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
  type CodexAppServerTransportOptions,
} from './codex-app-server-transport.js';
import type { Input as CodexInput, Thread as CodexThread, ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import { getBackendAuth } from '../store.js';
import { normalizeBackendBaseUrl } from '../normalize-base-url.js';
import {
  extractWorkReportFrame,
  type WorkerAdapterSignal,
} from '../worker-protocol.js';
import {
  compileCodexTaskProfile,
  type BackendRuntime,
} from './task-profile.js';
import type {
  BackendEffectiveProfile,
  TaskExecutionProfile,
} from '../task-collaboration.js';

const CODEX_CAPABILITIES: BackendCapabilities = {
  coordinate: true,
  executeTasks: true,
  displayName: 'Codex',
  iconId: 'codex',
  // WorkReport is synthesized at the app-server boundary; MCP mounting is not
  // required for the Worker contract.
  mcp: false,
  permissions: true,
  systemPrompt: true,
  skills: false,
  interrupt: true,
  defaultModel: 'gpt-5.4',
  npmPackage: '@openai/codex',
  installHint: 'npm install -g @openai/codex',
};

function codexReasoningEffort(
  config: BackendSessionConfig,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  const effort = config.taskProfile?.nativeReasoning?.modelReasoningEffort;
  return (
    effort === 'minimal'
    || effort === 'low'
    || effort === 'medium'
    || effort === 'high'
    || effort === 'xhigh'
  ) ? effort : undefined;
}

export function mapCodexItemToWorkerSignals(
  item: Record<string, unknown>,
  phase: 'started' | 'completed' = 'completed',
): WorkerAdapterSignal[] {
  const type = String(item.type ?? '');
  if (type === 'agentMessage' || type === 'agent_message') {
    const text = typeof item.text === 'string' ? item.text : '';
    const visible = text.split(/```work-report/i, 1)[0].trim();
    return visible ? [{ kind: 'progress', message: visible }] : [];
  }
  if (type === 'reasoning') {
    const text = typeof item.text === 'string'
      ? item.text
      : Array.isArray(item.summary)
        ? item.summary.map(String).join('\n')
        : '';
    return text.trim() ? [{ kind: 'progress', message: text.trim() }] : [];
  }
  if (type === 'todoList' || type === 'todo_list') {
    return [{ kind: 'progress', message: 'Updated task checklist' }];
  }

  let toolName = '';
  let failed = false;
  let detail: string | undefined;
  if (type === 'commandExecution' || type === 'command_execution') {
    toolName = 'Bash';
    detail = typeof item.command === 'string' ? item.command.slice(0, 4_000) : undefined;
    failed = item.status === 'failed'
      || (typeof item.exitCode === 'number' && item.exitCode !== 0)
      || (typeof item.exit_code === 'number' && item.exit_code !== 0);
  } else if (type === 'fileChange' || type === 'file_change') {
    toolName = 'Write';
    const changes = Array.isArray(item.changes) ? item.changes : [];
    detail = changes.filter(isRecord).map((change) => String(change.path ?? '')).filter(Boolean)
      .join(', ').slice(0, 4_000) || undefined;
    failed = item.status === 'failed';
  } else if (type === 'mcpToolCall' || type === 'mcp_tool_call') {
    toolName = `mcp__${String(item.server ?? 'unknown')}__${String(item.tool ?? 'unknown')}`;
    failed = Boolean(item.error);
  } else if (type === 'webSearch' || type === 'web_search') {
    toolName = 'WebSearch';
    detail = typeof item.query === 'string' ? item.query.slice(0, 4_000) : undefined;
  } else if (type === 'error') {
    return [{
      kind: 'failed',
      code: 'codex-item-error',
      message: typeof item.message === 'string' ? item.message : 'Codex item failed',
      retryable: true,
    }];
  } else {
    return [];
  }
  return [{
    kind: 'tool',
    toolName,
    phase: failed ? 'failed' : phase,
    ...(detail ? { detail } : {}),
  }];
}

export function finalizeCodexWorkerText(text: string): WorkerAdapterSignal[] {
  const extracted = extractWorkReportFrame(text);
  if (extracted.report) {
    return [
      { kind: 'delivery', report: extracted.report },
      { kind: 'ended', reason: 'completed' },
    ];
  }
  return [{
    kind: 'failed',
    code: extracted.error ? 'invalid-work-report' : 'missing-work-report',
    message: extracted.error
      ? `Codex returned an invalid WorkReport: ${extracted.error}`
      : 'Codex turn ended without a WorkReport',
    retryable: true,
  }, { kind: 'ended', reason: 'completed' }];
}

/** Only pass a model override when the user explicitly configured one. */
function codexModelOverride(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed ? trimmed : undefined;
}

/** OAuth entry point for the bundled Codex 0.144.x command contract. */
export function codexLoginArgs(): string[] {
  return ['login'];
}

// ── Dynamic SDK import ─────────────────────────────────────────────────────────
// Keep runtime loading lazy, but take every protocol type from the locked SDK.

type CodexSdk = typeof import('@openai/codex-sdk').Codex;

let codexSdkCache: CodexSdk | null | undefined;

async function loadCodexSdk(): Promise<CodexSdk | null> {
  if (codexSdkCache !== undefined) return codexSdkCache;
  try {
    const mod = await import('@openai/codex-sdk');
    codexSdkCache = mod.Codex;
    return codexSdkCache;
  } catch {
    codexSdkCache = null;
    return null;
  }
}

export function mapCodexApprovalRequest(
  request: CodexAppServerRequest,
): { toolName: string; input: Record<string, unknown>; toolUseID: string } | null {
  const params = isRecord(request.params) ? request.params : {};
  const toolUseID = String(params.itemId ?? params.callId ?? request.id);
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
      return {
        toolName: 'Bash',
        input: {
          command: String(params.command ?? ''),
          cwd: String(params.cwd ?? ''),
          reason: params.reason ?? null,
          commandActions: Array.isArray(params.commandActions) ? params.commandActions : [],
          additionalPermissions: params.additionalPermissions ?? null,
        },
        toolUseID,
      };
    case 'item/fileChange/requestApproval':
      return {
        toolName: 'Write',
        input: {
          reason: params.reason ?? null,
          grantRoot: params.grantRoot ?? null,
        },
        toolUseID,
      };
    case 'item/permissions/requestApproval':
      return {
        toolName: 'RequestPermissions',
        input: {
          cwd: String(params.cwd ?? ''),
          reason: params.reason ?? null,
          permissions: isRecord(params.permissions) ? params.permissions : {},
        },
        toolUseID,
      };
    case 'execCommandApproval':
      return {
        toolName: 'Bash',
        input: {
          command: Array.isArray(params.command) ? params.command.map(String) : [],
          cwd: String(params.cwd ?? ''),
          reason: params.reason ?? null,
          parsedCommand: Array.isArray(params.parsedCmd) ? params.parsedCmd : [],
        },
        toolUseID,
      };
    case 'applyPatchApproval':
      return {
        toolName: 'Write',
        input: {
          fileChanges: isRecord(params.fileChanges) ? params.fileChanges : {},
          reason: params.reason ?? null,
          grantRoot: params.grantRoot ?? null,
        },
        toolUseID,
      };
    default:
      return null;
  }
}

export function codexApprovalResponse(
  request: CodexAppServerRequest,
  decision: 'allow' | 'deny',
): Record<string, unknown> {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: decision === 'allow' ? 'accept' : 'decline' };
    case 'item/permissions/requestApproval': {
      const params = isRecord(request.params) ? request.params : {};
      const requested = isRecord(params.permissions) ? params.permissions : {};
      return {
        permissions: decision === 'allow'
          ? {
              ...(requested.network ? { network: requested.network } : {}),
              ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
            }
          : {},
        scope: 'turn',
      };
    }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: decision === 'allow' ? 'approved' : 'denied' };
    default:
      throw new Error(`Unsupported Codex approval method: ${request.method}`);
  }
}

// ── Session implementation ─────────────────────────────────────────────────────

class CodexAppServerSession implements BackendSession {
  private transport: CodexAppServerTransport | null = null;
  private threadId: string | null = null;
  private currentTurnId: string | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private turnWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private completedTurns = new Set<string>();
  private closed = false;
  private endedEmitted = false;
  private authRequiredEmitted = false;
  private backendVersion: string | undefined;
  private meetingCommandHandler?: (command: unknown) => Promise<unknown> | unknown;
  private readonly isWorker: boolean;
  private workerText: string[] = [];
  private suppressedWorkerTurns = new Set<string>();
  private permissionSequence = 0;
  private permissionResolvers = new Map<string, {
    request: CodexAppServerRequest;
    resolve: (value: unknown) => void;
  }>();

  constructor(
    private readonly binaryPath: string | null,
    private readonly config: BackendSessionConfig,
    private emit: (event: BackendSessionEvent) => void,
    private readonly createTransport: (options: CodexAppServerTransportOptions) => CodexAppServerTransport =
      (options) => new CodexAppServerTransport(options),
  ) {
    this.isWorker = config.executionRole === 'worker';
    const handler = config.extra?.meetingCommandHandler;
    if (typeof handler === 'function') {
      this.meetingCommandHandler = handler as (command: unknown) => Promise<unknown> | unknown;
    }
  }

  async start(): Promise<void> {
    if (!this.binaryPath) throw new Error('Codex CLI runtime is unavailable');
    this.transport = this.createTransport({
      binaryPath: this.binaryPath,
      env: this.config.env ?? isolatedSubprocessEnv(),
      onNotification: (notification) => this.onNotification(notification),
      onRequest: (request) => this.onRequest(request),
      onStderr: (line) => {
        if (isCodexAuthError(line)) this.emitAuthRequired();
      },
      onExit: (error) => {
        if (this.closed) return;
        this.transport = null;
        this.cancelPendingPermissions();
        this.resolveTurnWaiters();
        const message = `Codex app-server error: ${error.message}`;
        if (this.isWorker) {
          this.emit({
            kind: 'worker-signal',
            signal: { kind: 'failed', code: 'codex-app-server-exited', message, retryable: true },
          });
          this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'crashed' } });
        } else {
          this.emit({ kind: 'error', error: message });
          this.emitEnded();
        }
      },
    });
    try {
      const ready = await this.transport.start();
      this.backendVersion = extractCodexRuntimeVersion(ready.userAgent) ?? undefined;
      const options: Record<string, unknown> = {
        cwd: this.config.cwd,
        approvalPolicy: this.config.executionRole === 'worker' ? 'untrusted' : 'never',
        sandbox: this.config.executionRole === 'worker' ? 'workspace-write' : 'read-only',
        developerInstructions: this.config.systemPrompt,
        experimentalRawEvents: false,
      };
      const model = codexModelOverride(this.config.model);
      if (model) options.model = model;
      const reasoningEffort = codexReasoningEffort(this.config);
      if (reasoningEffort) options.modelReasoningEffort = reasoningEffort;
      this.threadId = this.config.resumeSessionId
        ? await this.transport.resumeThread(this.config.resumeSessionId, options)
        : await this.transport.openThread(options);
    } catch (error) {
      if (isCodexAuthError(String(error))) this.emitAuthRequired();
      this.transport.close();
      this.transport = null;
      throw error;
    }
  }

  private onRequest(request: CodexAppServerRequest): Promise<unknown> {
    const mapped = mapCodexApprovalRequest(request);
    if (!mapped) {
      return Promise.reject(new Error(`Unsupported Codex app-server request: ${request.method}`));
    }
    const id = `codex:${++this.permissionSequence}:${String(request.id)}`;
    return new Promise((resolve) => {
      this.permissionResolvers.set(id, { request, resolve });
      this.emit({
        kind: 'permission-request',
        id,
        toolName: mapped.toolName,
        input: mapped.input,
        toolUseID: mapped.toolUseID,
      });
    });
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    this.enqueueTurn([{ type: 'text', text, text_elements: [] }]);
  }

  sendUserContent(content: string | UserContentBlock[], _priority?: InputPriority): void {
    if (typeof content === 'string') {
      this.sendUserText(content);
      return;
    }
    const input = content.map((block) => block.type === 'text'
      ? { type: 'text', text: block.text, text_elements: [] }
      : { type: 'image', url: `data:${block.source.media_type};base64,${block.source.data}` });
    if (input.length > 0) this.enqueueTurn(input);
  }

  private enqueueTurn(input: unknown[]): void {
    if (this.closed || this.authRequiredEmitted || !this.transport || !this.threadId) return;
    this.turnQueue = this.turnQueue.then(async () => {
      if (this.closed || this.authRequiredEmitted || !this.transport || !this.threadId) return;
      let turnId: string | null = null;
      try {
        if (this.isWorker) this.workerText = [];
        turnId = await this.transport.startTurn(this.threadId, input);
        this.currentTurnId = turnId;
        await this.waitForTurn(turnId);
      } catch (error) {
        if (isCodexAuthError(String(error))) this.emitAuthRequired();
        else if (!this.closed) this.emit({ kind: 'error', error: `Codex error: ${String(error)}` });
      } finally {
        if (turnId) this.completedTurns.delete(turnId);
        this.currentTurnId = null;
      }
    });
  }

  private waitForTurn(turnId: string): Promise<void> {
    if (this.completedTurns.delete(turnId)) return Promise.resolve();
    const existing = this.turnWaiters.get(turnId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.turnWaiters.set(turnId, { promise, resolve });
    return promise;
  }

  private completeTurn(turnId: string): void {
    const pending = this.turnWaiters.get(turnId);
    this.completedTurns.add(turnId);
    if (pending) {
      this.turnWaiters.delete(turnId);
      pending.resolve();
    }
  }

  private onNotification(notification: CodexAppServerNotification): void {
    if (this.closed || !isRecord(notification.params)) return;
    if (
      (notification.method === 'item/started'
        || notification.method === 'item/updated'
        || notification.method === 'item/completed')
      && isRecord(notification.params.item)
    ) {
      if (this.isWorker) {
        const item = notification.params.item;
        if (notification.method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
          this.workerText.push(item.text);
        }
        const phase = notification.method === 'item/completed' ? 'completed' : 'started';
        for (const signal of mapCodexItemToWorkerSignals(item, phase)) {
          this.emit({ kind: 'worker-signal', signal });
        }
        return;
      }
      const message = this.normalizeAppServerItem(notification.params.item);
      if (message) this.emit({ kind: 'message', message });
      return;
    }
    if (notification.method === 'turn/completed' && isRecord(notification.params.turn)) {
      const turn = notification.params.turn;
      const turnId = typeof turn.id === 'string' ? turn.id : '';
      const suppressed = turnId ? this.suppressedWorkerTurns.delete(turnId) : false;
      if (turn.status === 'failed') {
        const detail = isRecord(turn.error) ? String(turn.error.message ?? 'Turn failed') : 'Turn failed';
        if (isCodexAuthError(detail)) this.emitAuthRequired();
        else if (this.isWorker && !suppressed) {
          this.emit({
            kind: 'worker-signal',
            signal: {
              kind: 'failed',
              code: 'codex-turn-failed',
              message: `Codex turn failed: ${detail}`,
              retryable: true,
            },
          });
        } else if (!suppressed) this.emit({ kind: 'error', error: `Codex turn failed: ${detail}` });
      } else if (this.isWorker && !suppressed) {
        for (const signal of finalizeCodexWorkerText(this.workerText.join('\n'))) {
          this.emit({ kind: 'worker-signal', signal });
        }
      }
      if (turnId) this.completeTurn(turnId);
      return;
    }
    if (notification.method === 'error') {
      const error = isRecord(notification.params.error) ? notification.params.error : {};
      const detail = String(error.message ?? 'Codex app-server error');
      if (isCodexAuthError(detail)) this.emitAuthRequired();
      else if (!notification.params.willRetry) {
        if (this.isWorker) {
          this.emit({
            kind: 'worker-signal',
            signal: { kind: 'failed', code: 'codex-app-server-error', message: detail, retryable: true },
          });
        } else this.emit({ kind: 'error', error: detail });
      }
    }
  }

  private normalizeAppServerItem(item: Record<string, unknown>): NormalizedMessage | null {
    const id = typeof item.id === 'string' ? item.id : `codex-${Date.now()}`;
    switch (item.type) {
      case 'agentMessage': {
        const text = typeof item.text === 'string' ? item.text : '';
        const { visibleText, hasSpeakCommand, hasNonSpeakCommand } = dispatchAppServerCommands(
          text, this.meetingCommandHandler, this.emit,
        );
        if (hasSpeakCommand) return null;
        const chatText = visibleText || (hasNonSpeakCommand ? COMMAND_ONLY_ACK : '');
        if (!chatText) return null;
        return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: chatText }] }, raw: item };
      }
      case 'reasoning': {
        const summary = Array.isArray(item.summary) ? item.summary.map(String).join('\n') : '';
        return summary ? { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: summary }] }, raw: item } : null;
      }
      case 'commandExecution': {
        const status = String(item.status ?? 'completed');
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '';
        const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
        return {
          type: 'assistant',
          message: { role: 'assistant', content: [
            { type: 'tool_use', id, name: 'Bash', input: { command: String(item.command ?? '') } },
            {
              type: 'tool_result', tool_use_id: id,
              content: output || `[${status}; exit ${exitCode ?? 'unknown'}]`,
              ...(status === 'failed' || (exitCode !== null && exitCode !== 0) ? { is_error: true } : {}),
            },
          ] },
          raw: item,
        };
      }
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        return {
          type: 'assistant',
          message: { role: 'assistant', content: changes.filter(isRecord).map((change, index) => ({
            type: 'tool_use' as const,
            id: `${id}:${index}`,
            name: 'Write',
            input: { file_path: change.path, change_kind: change.kind, status: item.status },
          })) },
          raw: item,
        };
      }
      case 'mcpToolCall':
        return {
          type: 'assistant',
          message: { role: 'assistant', content: [{
            type: 'tool_use', id, name: `mcp__${String(item.server)}__${String(item.tool)}`,
            input: isRecord(item.arguments) ? item.arguments : { value: item.arguments },
          }] },
          raw: item,
        };
      default:
        return null;
    }
  }

  resolvePermission(id: string, decision: 'allow' | 'deny', _message?: string): void {
    const pending = this.permissionResolvers.get(id);
    if (!pending) return;
    this.permissionResolvers.delete(id);
    pending.resolve(codexApprovalResponse(pending.request, decision));
  }

  async interrupt(reason: 'steer' | 'user' | 'shutdown' = 'user'): Promise<void> {
    if (!this.transport || !this.threadId || !this.currentTurnId) return;
    const turnId = this.currentTurnId;
    if (this.isWorker) this.suppressedWorkerTurns.add(turnId);
    await this.transport.interruptTurn(this.threadId, turnId);
    await withCodexTimeout(this.waitForTurn(turnId), 10_000, 'Codex interrupt timed out');
    if (this.isWorker && reason !== 'steer') {
      this.emit({ kind: 'worker-signal', signal: { kind: 'ended', reason: 'interrupted' } });
    }
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport?.close();
    this.transport = null;
    this.cancelPendingPermissions();
    this.resolveTurnWaiters();
    this.emitEnded();
    this.emit = () => {};
  }

  private cancelPendingPermissions(): void {
    for (const [id, pending] of this.permissionResolvers) {
      this.permissionResolvers.delete(id);
      pending.resolve(codexApprovalResponse(pending.request, 'deny'));
      this.emit({ kind: 'permission-cancelled', id });
    }
  }

  private resolveTurnWaiters(): void {
    for (const pending of this.turnWaiters.values()) pending.resolve();
    this.turnWaiters.clear();
  }

  snapshot(): { protocol: string; sessionId: string; protocolVersion: string; backendVersion?: string } | null {
    return this.threadId ? {
      protocol: 'codex-app-server', protocolVersion: 'v2',
      sessionId: this.threadId, backendVersion: this.backendVersion,
    } : null;
  }

  private emitAuthRequired(): void {
    if (this.authRequiredEmitted) return;
    this.authRequiredEmitted = true;
    const message = 'Codex 登录已失效，请完成重新认证后重连 Host。';
    if (this.isWorker) {
      this.emit({
        kind: 'worker-signal',
        signal: { kind: 'failed', code: 'auth-required', message, retryable: false },
      });
    } else {
      this.emit({ kind: 'auth-required', error: message });
    }
  }

  private emitEnded(): void {
    if (this.endedEmitted) return;
    this.endedEmitted = true;
    if (!this.isWorker) this.emit({ kind: 'ended' });
  }
}

class CodexSession implements BackendSession {
  private thread: CodexThread | null = null;
  private closed = false;
  private emit: (e: BackendSessionEvent) => void;
  private config: BackendSessionConfig;
  private apiKey?: string;
  private baseUrl?: string;
  private turnQueue: Promise<void> = Promise.resolve();
  private binaryPath: string | null;
  private currentAbort: AbortController | null = null;
  private turnAborts = new Set<AbortController>();
  private meetingCommandHandler?: (command: unknown) => Promise<unknown> | unknown;
  private authRequiredEmitted = false;
  private sessionId: string | null = null;

  constructor(
    binaryPath: string | null,
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
    private readonly sdkLoader: () => Promise<CodexSdk | null> = loadCodexSdk,
  ) {
    this.binaryPath = binaryPath;
    this.config = config;
    this.emit = emit;
    // Read API key and base URL from config.env where buildEnv placed them
    this.apiKey = config.env?.OPENAI_API_KEY;
    this.baseUrl = config.env?.OPENAI_BASE_URL;
    const handler = config.extra?.meetingCommandHandler;
    if (typeof handler === 'function') {
      this.meetingCommandHandler = handler as (command: unknown) => Promise<unknown> | unknown;
    }
  }

  start(): Promise<void> {
    return this.initAndRun();
  }

  private async initAndRun(): Promise<void> {
    const Codex = await this.sdkLoader();
    if (!Codex) {
      throw new Error('@openai/codex-sdk not installed. Run: npm install @openai/codex-sdk');
    }

    const envStrings: Record<string, string> = {};
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (typeof v === 'string') envStrings[k] = v;
      }
    }

    try {
      const codex = new Codex({
        codexPathOverride: this.binaryPath ?? undefined,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        env: Object.keys(envStrings).length > 0 ? envStrings : undefined,
      });
      const model = codexModelOverride(this.config.model);
      const reasoningEffort = codexReasoningEffort(this.config);
      const threadOptions = {
        workingDirectory: this.config.cwd,
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
        approvalPolicy: this.config.executionRole === 'worker' ? 'untrusted' : 'never',
        sandboxMode: this.config.executionRole === 'worker' ? 'workspace-write' : 'read-only',
        skipGitRepoCheck: true,
      } as const;
      this.thread = this.config.resumeSessionId
        ? codex.resumeThread(this.config.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);
      this.sessionId = this.config.resumeSessionId ?? this.thread.id;
    } catch (err: unknown) {
      throw new Error(`Codex SDK init failed: ${String(err)}`);
    }

    // Initial prompt: system instructions + "ready" signal
    const systemPrefix = this.config.systemPrompt
      ? `${this.config.systemPrompt}\n\n---\n\n`
      : '';
    const initialPrompt = systemPrefix + 'Ready. Awaiting instructions.';

    try {
      this.currentAbort = new AbortController();
      const { events } = await this.thread.runStreamed(initialPrompt, { signal: this.currentAbort.signal });

      for await (const event of events) {
        if (this.closed) break;
        const msg = this.normalizeEvent(event);
        if (msg) {
          this.emit({ kind: 'message', message: msg });
        }
      }
      if (this.authRequiredEmitted) {
        throw new Error('Codex authentication required');
      }
    } catch (err: unknown) {
      if (isCodexAuthError(String(err))) {
        if (!this.closed) this.emitAuthRequired();
        throw new Error('Codex authentication required', { cause: err });
      }
      if (!this.closed) this.emit({ kind: 'error', error: `Codex stream error: ${String(err)}` });
      if (!this.closed) throw err;
    } finally {
      this.currentAbort = null;
    }
  }

  private normalizeEvent(event: ThreadEvent): NormalizedMessage | null {
    switch (event.type) {
      case 'thread.started':
        this.sessionId = event.thread_id;
        return null;
      case 'item.completed':
        return this.normalizeItem(event.item);
      case 'turn.failed':
        if (isCodexAuthError(event.error?.message ?? '')) {
          this.emitAuthRequired();
          return null;
        }
        return {
          type: 'assistant',
          errorCode: 'codex_turn_failed',
          errorDetail: event.error?.message ?? 'Turn failed',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Error: ${event.error?.message ?? 'Turn failed'}` }],
          },
        };
      case 'turn.completed':
      case 'turn.started':
      case 'item.started':
      case 'item.updated':
        return null;
      case 'error':
        if (isCodexAuthError(event.message)) {
          this.emitAuthRequired();
          return null;
        }
        return {
          type: 'assistant', errorCode: 'codex_stream_error', errorDetail: event.message,
          message: { role: 'assistant', content: [{ type: 'text', text: `Error: ${event.message}` }] },
        };
      default:
        return assertNever(event);
    }
  }

  private normalizeItem(item?: ThreadItem): NormalizedMessage | null {
    if (!item) return null;

    switch (item.type) {
      case 'agent_message':
        {
          const { visibleText, hasSpeakCommand, hasNonSpeakCommand } = this.dispatchMeetingCommands(item.text);
          // `speak` is rendered by Orchestrator.narrateAssistantLine(). Emitting
          // the agent message as well would show the same sentence twice and
          // leak the fenced protocol payload into the chat transcript.
          if (hasSpeakCommand) return null;
          const chatText = visibleText || (hasNonSpeakCommand ? COMMAND_ONLY_ACK : '');
          if (!chatText) return null;
          return {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: chatText }],
            },
            raw: item,
          };
        }

      case 'command_execution':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: item.id,
                name: 'Bash',
                input: { command: item.command },
              },
              {
                type: 'tool_result',
                tool_use_id: item.id,
                content: item.aggregated_output || `[${item.status}; exit ${item.exit_code ?? 'unknown'}]`,
                ...(item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0)
                  ? { is_error: true }
                  : {}),
              },
            ],
          },
          raw: item,
        };

      case 'file_change':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: item.changes.map((change, index) => ({
                type: 'tool_use',
                id: `${item.id}:${index}`,
                name: 'Write',
                input: { file_path: change.path, change_kind: change.kind, status: item.status },
              })),
          },
          raw: item,
        };

      case 'mcp_tool_call':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: item.id,
                name: `mcp__${item.server}__${item.tool}`,
                input: isRecord(item.arguments) ? item.arguments : { value: item.arguments },
              },
              ...(item.result ? [{
                type: 'tool_result' as const,
                tool_use_id: item.id,
                content: JSON.stringify(item.result.content),
              }] : item.error ? [{
                type: 'tool_result' as const,
                tool_use_id: item.id,
                content: item.error.message,
                is_error: true,
              }] : []),
            ],
          },
          raw: item,
        };

      case 'error':
        // Codex emits a generic item error immediately before turn.failed.
        // The latter contains the actionable detail, so displaying both
        // creates the repeated "Error: Item error" noise seen in chat.
        if (!item.message || item.message === 'Item error') return null;
        return {
          type: 'assistant',
          errorCode: 'codex_item_error',
          errorDetail: item.message,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `Error: ${item.message}` }],
          },
        };

      case 'reasoning':
        return item.text ? {
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: item.text }] },
          raw: item,
        } : null;

      case 'web_search':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: item.id, name: 'WebSearch', input: { query: item.query } },
              { type: 'tool_result', tool_use_id: item.id, content: 'Search completed' },
            ],
          },
          raw: item,
        };

      case 'todo_list':
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'text',
              text: item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n'),
            }],
          },
          raw: item,
        };

      default:
        return assertNever(item);
    }
  }

  private emitAuthRequired(): void {
    if (this.authRequiredEmitted) return;
    this.authRequiredEmitted = true;
    this.emit({ kind: 'auth-required', error: 'Codex 登录已失效，请完成重新认证后重连 Host。' });
  }

  private dispatchMeetingCommands(text: string): {
    visibleText: string; hasSpeakCommand: boolean; hasNonSpeakCommand: boolean;
  } {
    const fenced = /```meeting-command\s*([\s\S]*?)```/gi;
    let hasSpeakCommand = false;
    let hasNonSpeakCommand = false;
    for (const match of text.matchAll(fenced)) {
      try {
        const command = JSON.parse(match[1]);
        if (
          command?.kind === 'speak'
          && typeof command.text === 'string'
          && command.text.trim().length > 0
        ) hasSpeakCommand = true;
        else hasNonSpeakCommand = true;
        if (this.meetingCommandHandler) {
          void Promise.resolve(this.meetingCommandHandler(command)).catch((err) => {
            this.emit({ kind: 'error', error: `Meeting command failed: ${String(err)}` });
          });
        }
      } catch (err) {
        this.emit({ kind: 'error', error: `Invalid meeting-command JSON: ${String(err)}` });
      }
    }
    return {
      visibleText: text.replace(fenced, '').trim(),
      hasSpeakCommand,
      hasNonSpeakCommand,
    };
  }

  end(): void {
    this.closed = true;
    this.currentAbort?.abort();
    for (const abort of this.turnAborts) abort.abort();
    this.emit({ kind: 'ended' });
    this.emit = () => {};
  }

  sendUserText(text: string, _priority?: InputPriority): void {
    this.enqueueTurn(async () => ({ input: text }));
  }

  private enqueueTurn(
    prepare: () => Promise<{ input: CodexInput; cleanup?: () => Promise<void> }>,
  ): void {
    if (!this.thread || this.closed || this.authRequiredEmitted) return;
    const thread = this.thread; // Capture thread reference before async boundary
    const abort = new AbortController();
    this.turnAborts.add(abort);
    // Serialize turns to prevent concurrent runStreamed calls on the same thread
    this.turnQueue = this.turnQueue.then(async () => {
      let cleanup: (() => Promise<void>) | undefined;
      try {
        if (this.closed || this.authRequiredEmitted || abort.signal.aborted) return;
        this.currentAbort = abort;
        const prepared = await prepare();
        cleanup = prepared.cleanup;
        if (this.closed || this.authRequiredEmitted || abort.signal.aborted) return;
        const { events } = await thread.runStreamed(prepared.input, { signal: abort.signal });
        for await (const event of events) {
          if (this.closed) break;
          const msg = this.normalizeEvent(event);
          if (msg) this.emit({ kind: 'message', message: msg });
        }
      } catch (err: unknown) {
        if (!this.closed && !(err instanceof Error && err.name === 'AbortError')) {
          if (isCodexAuthError(String(err))) this.emitAuthRequired();
          else this.emit({ kind: 'error', error: `Codex error: ${String(err)}` });
        }
      } finally {
        if (this.currentAbort === abort) this.currentAbort = null;
        this.turnAborts.delete(abort);
        await cleanup?.();
      }
    }).catch((err: unknown) => {
      // Log instead of silently swallowing — unhandled rejections in the queue
      // chain indicate a bug that should surface, not disappear.
      if (!this.closed) {
        this.emit({ kind: 'error', error: `Codex turn queue error: ${String(err)}` });
      }
    });
  }

  sendUserContent(content: string | UserContentBlock[], _priority?: InputPriority): void {
    if (typeof content === 'string') {
      this.sendUserText(content);
      return;
    }
    if (content.length === 0) return;
    this.enqueueTurn(() => materializeCodexInput(content));
  }

  resolvePermission(_id: string, _decision: 'allow' | 'deny', _message?: string): void {
    // Codex uses approvalPolicy config, not interactive permissions.
  }

  async interrupt(): Promise<void> {
    this.currentAbort?.abort();
    for (const abort of this.turnAborts) abort.abort();
  }

  snapshot(): { protocol: string; sessionId: string } | null {
    return this.sessionId ? { protocol: 'codex-sdk', sessionId: this.sessionId } : null;
  }
}

const MAX_CODEX_IMAGE_BYTES = 20 * 1024 * 1024;

async function materializeCodexInput(
  content: UserContentBlock[],
): Promise<{ input: CodexInput; cleanup?: () => Promise<void> }> {
  const input: Exclude<CodexInput, string> = [];
  const images = content.filter((block) => block.type === 'image');
  let directory: string | undefined;
  let totalBytes = 0;
  try {
    if (images.length > 0) {
      directory = await mkdtemp(join(tmpdir(), 'ahastation-codex-'));
      await chmod(directory, 0o700);
    }
    let imageIndex = 0;
    for (const block of content) {
      if (block.type === 'text') {
        input.push({ type: 'text', text: block.text });
        continue;
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(block.source.data) || block.source.data.length % 4 !== 0) {
        throw new Error('Invalid base64 image payload');
      }
      const estimatedBytes = Math.floor(block.source.data.length * 3 / 4);
      if (totalBytes + estimatedBytes > MAX_CODEX_IMAGE_BYTES) {
        throw new Error('Codex image payload exceeds the 20 MB per-turn limit');
      }
      const bytes = Buffer.from(block.source.data, 'base64');
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_CODEX_IMAGE_BYTES) {
        throw new Error('Codex image payload exceeds the 20 MB per-turn limit');
      }
      const path = join(directory!, `image-${imageIndex}.${imageExtension(block.source.media_type)}`);
      imageIndex += 1;
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      input.push({ type: 'local_image', path });
    }
    return {
      input,
      cleanup: directory ? () => rm(directory!, { recursive: true, force: true }) : undefined,
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function imageExtension(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'png';
  }
}

function isCodexAuthError(message: string): boolean {
  return /\b401\b|unauthorized|missing bearer|authentication (?:is )?required/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dispatchAppServerCommands(
  text: string,
  handler: ((command: unknown) => Promise<unknown> | unknown) | undefined,
  emit: (event: BackendSessionEvent) => void,
): { visibleText: string; hasSpeakCommand: boolean; hasNonSpeakCommand: boolean } {
  const fenced = /```meeting-command\s*([\s\S]*?)```/gi;
  let hasSpeakCommand = false;
  let hasNonSpeakCommand = false;
  for (const match of text.matchAll(fenced)) {
    try {
      const command = JSON.parse(match[1]);
      if (command?.kind === 'speak' && typeof command.text === 'string' && command.text.trim()) {
        hasSpeakCommand = true;
      } else hasNonSpeakCommand = true;
      if (handler) {
        void Promise.resolve(handler(command)).catch((error) => {
          emit({ kind: 'error', error: `Meeting command failed: ${String(error)}` });
        });
      }
    } catch (error) {
      emit({ kind: 'error', error: `Invalid meeting-command JSON: ${String(error)}` });
    }
  }
  return { visibleText: text.replace(fenced, '').trim(), hasSpeakCommand, hasNonSpeakCommand };
}

const COMMAND_ONLY_ACK = '我正在处理，有结果会马上告诉你。';

function assertNever(value: never): null {
  void value;
  return null;
}

async function withCodexTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Backend implementation ─────────────────────────────────────────────────────

export class CodexBackend implements CliBackend {
  readonly id = 'codex';
  readonly capabilities = CODEX_CAPABILITIES;

  constructor(private readonly deps: {
    resolveBinary?: () => string | null;
    execFile?: (binary: string, args: string[], options?: Record<string, unknown>) => string;
    loadSdk?: () => Promise<CodexSdk | null>;
    createAppServerTransport?: (options: CodexAppServerTransportOptions) => CodexAppServerTransport;
  } = {}) {}

  compileTaskProfile(
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile {
    return compileCodexTaskProfile(requested, runtime);
  }

  createSession(
    config: BackendSessionConfig,
    emit: (e: BackendSessionEvent) => void,
  ): BackendSession {
    if (config.extra?.codexTransport === 'app-server') {
      return new CodexAppServerSession(
        this.resolveBinary(), config, emit, this.deps.createAppServerTransport,
      );
    }
    return new CodexSession(this.resolveBinary(), config, emit, this.deps.loadSdk ?? loadCodexSdk);
  }

  resolveBinary(): string | null {
    return this.deps.resolveBinary?.() ?? resolveCodexRuntime();
  }

  buildEnv(auth: BackendAuthConfig, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = isolatedSubprocessEnv(extra);
    if (auth.apiKey) {
      env.OPENAI_API_KEY = auth.apiKey;
    }
    const baseUrl = normalizeBackendBaseUrl(auth.baseUrl);
    if (baseUrl) {
      env.OPENAI_BASE_URL = baseUrl;
    }
    return env;
  }

  async validateAuth(config: BackendAuthConfig): Promise<{ ok: boolean; error?: string }> {
    if (config.authMode === 'apikey' && !config.apiKey?.trim()) {
      return { ok: false, error: 'API Key is required (OpenAI or compatible gateway)' };
    }
    return { ok: true };
  }

  async checkAuthStatus(): Promise<{ loggedIn: boolean }> {
    const auth = getBackendAuth(this.id);
    if (auth?.apiKey?.trim()) return { loggedIn: true };
    const binary = this.resolveBinary();
    if (!binary) return { loggedIn: false };
    try {
      const run = this.deps.execFile ?? ((file: string, args: string[]) =>
        execFileSync(file, args, { env: isolatedSubprocessEnv(), encoding: 'utf8', timeout: 10_000 }));
      // Codex 0.144.x writes both success and failure status messages to stderr.
      // execFileSync returns stdout only, so the command's exit status is the
      // stable machine-readable contract: zero means authenticated; non-zero
      // throws and is handled below.
      run(binary, ['login', 'status'], { encoding: 'utf8', timeout: 10_000 });
      return { loggedIn: true };
    } catch {
      return { loggedIn: false };
    }
  }

  async loginOAuth(): Promise<{ ok: boolean; error?: string }> {
    const binary = this.resolveBinary();
    if (!binary) {
      return { ok: false, error: 'Codex CLI not found. Install it first.' };
    }
    // OAuth login needs an interactive terminal — launch in Terminal.app on macOS
    if (process.platform === 'darwin') {
      return runTerminalLogin(
        binary, codexLoginArgs(), () => this.checkAuthStatus(), isolatedSubprocessEnv(),
      );
    }
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const env = isolatedSubprocessEnv();
      const proc = spawn(binary, codexLoginArgs(), {
        env,
        stdio: 'inherit',
        detached: true,
      });
      proc.unref();
      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          void this.checkAuthStatus().then((status) => resolve(status.loggedIn
            ? { ok: true }
            : { ok: false, error: 'Codex 登录未完成，请重试。' }));
        } else {
          resolve({ ok: false, error: `codex auth login exited with code ${code}` });
        }
      });
    });
  }

}

/** Resolve an OS-executable Codex path. In a packaged Electron app the SDK is
 * loaded from app.asar, but child_process.spawn cannot execute an ASAR virtual
 * path. electron-builder unpacks the native platform package, so prefer that
 * real path and pass it to the SDK via codexPathOverride. */
export function resolveCodexRuntime(resourcesPath = process.resourcesPath): string | null {
  const platformPackage = process.platform === 'darwin'
    ? `codex-darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : process.platform === 'linux'
      ? `codex-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : process.platform === 'win32'
        ? `codex-win32-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
        : null;
  const triple = process.platform === 'darwin'
    ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : process.platform === 'linux'
      ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`
      : process.platform === 'win32'
        ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`
        : null;
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates: string[] = [];
  if (resourcesPath && platformPackage && triple) {
    candidates.push(join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@openai',
      platformPackage,
      'vendor',
      triple,
      'bin',
      binaryName,
    ));
  }
  const system = resolveBinaryFromPath('codex');
  if (system) candidates.push(system);
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      accessSync(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return realpathSync(candidate);
    } catch { /* try the next runtime */ }
  }
  return null;
}
