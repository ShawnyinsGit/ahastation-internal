// driver.ts — speaks the claude CLI stream-json protocol directly.
//
// Replaces @anthropic-ai/claude-agent-sdk. The local CLI is spawned with
// `--output-format stream-json --verbose --input-format stream-json`; user
// messages and control frames travel as newline-delimited JSON on stdin, and
// stream messages plus inbound control requests arrive as NDJSON on stdout.
//
// Control channel contract (mirrors the retired SDK's wire behavior):
//   outbound requests:  { request_id, type: 'control_request', request: { subtype, ... } }
//     subtypes used here: initialize / interrupt / set_permission_mode
//   inbound requests:   can_use_tool (→ PermissionResult & { toolUseID }),
//                       mcp_message (→ { mcp_response }), everything else
//                       gets an error control_response
//   inbound responses:  settle the matching pending outbound request
//
// In-process MCP servers ({ type: 'sdk', instance }) are declared through
// the initialize body's `sdkMcpServers`; external server configs go to
// --mcp-config untouched.

import { randomUUID } from 'node:crypto';
import { errorMessage } from '../format-error.js';
import { createCliTransport, type CliTransport, type SpawnFn } from './transport.js';
import { resolveClaudeBinaryForSource, spawnTargetFor } from './resolve.js';
import type { InProcMcpServer } from './inproc-mcp.js';
import type {
  CanUseTool,
  InitializationResult,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
  SessionOptions,
} from './types.js';

export interface ClaudeCliDriverOptions extends SessionOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  canUseTool?: CanUseTool;
  stderr?: (data: string) => void;
  /** Explicit binary override. Default: resolve the user's local claude CLI. */
  pathToClaudeCodeExecutable?: string;
  /** Test seam: replace child_process.spawn. */
  spawnProcess?: SpawnFn;
  /** Test seam: replace local-binary resolution. */
  resolveBinary?: () => string | null;
  log?: (line: string) => void;
}

export interface ClaudeCliQuery extends AsyncIterable<SDKMessage> {
  initializationResult(): Promise<InitializationResult>;
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Kill the CLI process and end the message stream immediately. */
  close(): void;
}

export type ClaudeCliQueryFactory = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: ClaudeCliDriverOptions;
}) => ClaudeCliQuery;

/** Default factory: resolves the local claude CLI and spawns it. */
export const query: ClaudeCliQueryFactory = ({ prompt, options }) => new CliQuery(prompt, options);

// ── argv / initialize-body construction ─────────────────────────────────────

export function buildCliArgs(
  options: SessionOptions,
  extra: { hasCanUseTool: boolean; externalMcpServers: Record<string, unknown> },
): string[] {
  const args = ['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json'];
  const thinking = options.thinking;
  if (thinking) {
    if (thinking.type === 'disabled') args.push('--thinking', 'disabled');
    else if (thinking.type === 'enabled' && typeof thinking.budgetTokens === 'number') {
      args.push('--max-thinking-tokens', String(thinking.budgetTokens));
    } else {
      args.push('--thinking', 'adaptive');
    }
    if (thinking.type !== 'disabled' && thinking.display) args.push('--thinking-display', thinking.display);
  }
  if (typeof options.effort === 'string' && options.effort) args.push('--effort', options.effort);
  if (options.model) args.push('--model', options.model);
  if (typeof options.resume === 'string' && options.resume) args.push('--resume', options.resume);
  if (options.skills !== undefined) {
    const skillTools = options.skills === 'all'
      ? ['Skill']
      : options.skills.map((name) => `Skill(${name})`);
    if (skillTools.length > 0) args.push('--allowedTools', skillTools.join(','));
  }
  if (options.tools !== undefined) {
    if (Array.isArray(options.tools)) {
      args.push('--tools', options.tools.length === 0 ? '' : options.tools.join(','));
    } else {
      args.push('--tools', 'default');
    }
  }
  if (Object.keys(extra.externalMcpServers).length > 0) {
    args.push('--mcp-config', JSON.stringify({ mcpServers: extra.externalMcpServers }));
  }
  if (options.settingSources !== undefined) {
    args.push(`--setting-sources=${options.settingSources.join(',')}`);
  }
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (extra.hasCanUseTool) args.push('--permission-prompt-tool', 'stdio');
  return args;
}

export function buildInitializeBody(
  options: SessionOptions,
  sdkServerNames: string[],
): Record<string, unknown> {
  const sp = options.systemPrompt;
  let systemPrompt: string[] | undefined;
  let appendSystemPrompt: string | undefined;
  let excludeDynamicSections: boolean | undefined;
  if (sp === undefined) systemPrompt = [''];
  else if (typeof sp === 'string') systemPrompt = [sp];
  else if (sp.type === 'preset') {
    appendSystemPrompt = sp.append;
    excludeDynamicSections = sp.excludeDynamicSections;
  }
  return {
    sdkMcpServers: sdkServerNames.length > 0 ? sdkServerNames : undefined,
    systemPrompt,
    appendSystemPrompt,
    excludeDynamicSections,
    skills: Array.isArray(options.skills) ? options.skills : undefined,
  };
}

// ── Query implementation ────────────────────────────────────────────────────

type ControlRequestFrame = {
  request_id?: unknown;
  request?: { subtype?: unknown } & Record<string, unknown>;
};

class CliQuery implements ClaudeCliQuery {
  private readonly transport: CliTransport;
  private readonly canUseTool: CanUseTool | undefined;
  private readonly sdkServers = new Map<string, InProcMcpServer>();
  private readonly pendingControl = new Map<string, {
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }>();
  private readonly cancelControllers = new Map<string, AbortController>();
  private readonly messages: SDKMessage[] = [];
  private readonly waiters: Array<{
    resolve: (r: IteratorResult<SDKMessage>) => void;
    reject: (e: Error) => void;
  }> = [];
  private streamError: Error | null = null;
  private streamDone = false;
  private closed = false;
  private readonly initialization: Promise<InitializationResult>;

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: ClaudeCliDriverOptions) {
    this.canUseTool = options.canUseTool;

    // Split mcpServers: in-process (sdk) instances are bridged over the
    // control channel; everything else is handed to the CLI via --mcp-config.
    const externalMcpServers: Record<string, unknown> = {};
    for (const [name, cfg] of Object.entries(options.mcpServers ?? {})) {
      const c = cfg as { type?: unknown; instance?: unknown } | null;
      if (c && c.type === 'sdk' && c.instance) {
        this.sdkServers.set(name, c.instance as InProcMcpServer);
      } else {
        externalMcpServers[name] = cfg;
      }
    }

    // An injected resolver is authoritative — even its null (tests simulate
    // "no CLI installed" that way). Unset: follow the user's claudeCodeCliSource
    // setting (system PATH first, app-bundled binary as the fallback).
    const binary = options.pathToClaudeCodeExecutable
      ?? (options.resolveBinary ? options.resolveBinary() : resolveClaudeBinaryForSource());
    if (!binary) {
      throw new Error(
        'Claude CLI not found — install Claude Code '
        + '(npm install -g @anthropic-ai/claude-code or https://claude.ai/install) '
        + 'and make sure `claude` is on PATH.',
      );
    }

    const argv = buildCliArgs(options, {
      hasCanUseTool: options.canUseTool !== undefined,
      externalMcpServers,
    });
    const target = spawnTargetFor(binary, argv);
    const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
    if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = 'aha-cli';
    delete env.NODE_OPTIONS;
    delete env.DEBUG;

    this.transport = createCliTransport(
      { file: target.file, args: target.args, cwd: options.cwd, env },
      {
        spawnFn: options.spawnProcess,
        stderr: options.stderr,
        log: options.log,
        onMessage: (msg) => this.onFrame(msg),
        onExit: (err) => this.finish(err),
      },
    );

    this.initialization = this.request({
      subtype: 'initialize',
      ...buildInitializeBody(options, Array.from(this.sdkServers.keys())),
    }).then((response) => (response.response ?? response) as InitializationResult);
    // The rejection is delivered through initializationResult(); don't let it
    // also crash the process as an unhandled rejection.
    this.initialization.catch(() => { /* surfaced via initializationResult() */ });

    void this.pumpInput(prompt);
  }

  initializationResult(): Promise<InitializationResult> {
    return this.initialization;
  }

  async interrupt(): Promise<void> {
    await this.request({ subtype: 'interrupt' });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.request({ subtype: 'set_permission_mode', mode });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close();
  }

  // ── AsyncIterable ─────────────────────────────────────────────────────────

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this;
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const queued = this.messages.shift();
    if (queued !== undefined) return Promise.resolve({ value: queued, done: false });
    if (this.streamError) {
      const err = this.streamError;
      this.streamError = null;
      return Promise.reject(err);
    }
    if (this.streamDone) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async return(): Promise<IteratorResult<SDKMessage>> {
    // Consumer broke out of the for-await loop — tear the process down so it
    // doesn't linger with stdin held open.
    this.close();
    return { value: undefined as never, done: true };
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async pumpInput(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const msg of prompt) {
        if (this.closed) break;
        this.transport.write(msg);
      }
    } catch {
      // The input source failing ends stdin; the session layer owns teardown.
    } finally {
      this.transport.endInput();
    }
  }

  private request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pendingControl.set(requestId, { resolve, reject });
      this.transport.write({ request_id: requestId, type: 'control_request', request });
    });
  }

  private onFrame(msg: Record<string, unknown>): void {
    const type = msg.type;
    if (type === 'control_response') {
      const response = (msg.response ?? {}) as {
        request_id?: unknown;
        subtype?: unknown;
        error?: unknown;
      } & Record<string, unknown>;
      const id = typeof response.request_id === 'string' ? response.request_id : '';
      const pending = this.pendingControl.get(id);
      if (!pending) return;
      this.pendingControl.delete(id);
      if (response.subtype === 'success') pending.resolve(response);
      else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'control request failed'));
      return;
    }
    if (type === 'control_request') {
      void this.handleControlRequest(msg as ControlRequestFrame);
      return;
    }
    if (type === 'control_cancel_request') {
      const id = typeof (msg as { request_id?: unknown }).request_id === 'string'
        ? (msg as { request_id: string }).request_id
        : '';
      this.cancelControllers.get(id)?.abort();
      this.cancelControllers.delete(id);
      return;
    }
    if (type === 'keep_alive' || type === 'transcript_mirror') return;
    this.push(msg as SDKMessage);
  }

  private async handleControlRequest(frame: ControlRequestFrame): Promise<void> {
    const requestId = typeof frame.request_id === 'string' ? frame.request_id : '';
    const request = frame.request ?? {};
    const controller = new AbortController();
    this.cancelControllers.set(requestId, controller);
    try {
      const response = await this.processControlRequest(request, controller.signal);
      this.transport.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      });
    } catch (err) {
      this.transport.write({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: errorMessage(err) },
      });
    } finally {
      this.cancelControllers.delete(requestId);
    }
  }

  private async processControlRequest(
    request: { subtype?: unknown } & Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (request.subtype === 'can_use_tool') {
      if (!this.canUseTool) throw new Error('canUseTool callback is not provided.');
      const toolUseID = typeof request.tool_use_id === 'string' ? request.tool_use_id : '';
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      const result = await this.canUseTool(
        typeof request.tool_name === 'string' ? request.tool_name : '',
        (request.input && typeof request.input === 'object' ? request.input : {}) as Record<string, unknown>,
        {
          signal,
          toolUseID,
          suggestions: request.permission_suggestions,
          blockedPath: str(request.blocked_path),
          decisionReason: str(request.decision_reason),
          title: str(request.title),
          displayName: str(request.display_name),
          description: str(request.description),
          agentID: str(request.agent_id),
        },
      );
      return { ...result, toolUseID };
    }
    if (request.subtype === 'mcp_message') {
      const serverName = typeof request.server_name === 'string' ? request.server_name : '';
      const server = this.sdkServers.get(serverName);
      if (!server) throw new Error(`SDK MCP server not found: ${serverName}`);
      const message = request.message as Record<string, unknown> | undefined;
      if (
        message
        && 'method' in message
        && 'id' in message
        && message.id !== null
        && message.id !== undefined
      ) {
        return { mcp_response: await server.dispatch(message) };
      }
      if (message) await server.dispatch(message);
      return { mcp_response: { jsonrpc: '2.0', result: {}, id: 0 } };
    }
    throw new Error(`Unsupported control request subtype: ${String(request.subtype)}`);
  }

  private push(msg: SDKMessage): void {
    if (this.streamDone) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: msg, done: false });
    else this.messages.push(msg);
  }

  private finish(err: Error | null): void {
    if (this.streamDone) return;
    this.streamDone = true;
    this.streamError = err;
    for (const [, pending] of this.pendingControl) {
      pending.reject(err ?? new Error('Claude CLI stream ended'));
    }
    this.pendingControl.clear();
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (err) waiter.reject(err);
      else waiter.resolve({ value: undefined as never, done: true });
    }
  }
}
