// inproc-mcp.ts — in-process MCP servers bridged over the CLI control channel.
//
// Drop-in replacement for the retired SDK's `createSdkMcpServer`/`tool`.
// A server created here is declared to the CLI via the `initialize` control
// request (`sdkMcpServers`); the CLI then forwards JSON-RPC messages for it
// as `mcp_message` control requests, which the driver routes to `dispatch()`.
//
// Only the slice of MCP these servers need is implemented:
//   initialize / notifications/initialized / ping / tools/list / tools/call.
// Argument validation stays server-side via zod, so a JSON-schema conversion
// failure degrades the advertised inputSchema instead of breaking the tool.

import { z } from 'zod';
import { errorMessage } from '../format-error.js';

/** Loose CallToolResult shape. Literal content objects from call sites
 *  (`{ type: 'text', text }` / `{ type: 'image', data, mimeType }`) must
 *  assign without casts, so `type` stays a plain string here. */
export interface McpToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

type ZodShape = Record<string, z.ZodType>;
type AnyZodSchema = z.ZodType;
type ErasedHandler = (args: never) => Promise<McpToolResult>;

export interface InProcTool {
  name: string;
  description: string;
  schema: AnyZodSchema;
  handler: ErasedHandler;
}

export function tool<Schema extends ZodShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<z.ZodObject<Schema>>) => Promise<McpToolResult>,
): InProcTool;
export function tool<S extends AnyZodSchema>(
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<S>) => Promise<McpToolResult>,
): InProcTool;
export function tool(
  name: string,
  description: string,
  inputSchema: ZodShape | AnyZodSchema,
  handler: ErasedHandler,
): InProcTool {
  const schema = isZodSchema(inputSchema) ? inputSchema : z.object(inputSchema);
  return { name, description, schema, handler };
}

function isZodSchema(value: unknown): value is AnyZodSchema {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

type JsonRpcId = string | number;

export interface InProcMcpServer {
  readonly name: string;
  readonly version: string;
  /** Handle one JSON-RPC message from the CLI. Returns the JSON-RPC response
   *  for requests, or null for notifications. */
  dispatch(message: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

class InProcMcpServerImpl implements InProcMcpServer {
  readonly name: string;
  readonly version: string;
  private readonly tools = new Map<string, InProcTool>();
  private readonly schemaCache = new Map<string, Record<string, unknown>>();

  constructor(name: string, version: string, tools: InProcTool[]) {
    this.name = name;
    this.version = version;
    for (const t of tools) this.tools.set(t.name, t);
  }

  async dispatch(message: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const method = typeof message.method === 'string' ? message.method : '';
    const hasId = 'id' in message && message.id !== null && message.id !== undefined;
    const id = message.id as JsonRpcId;
    if (!method) {
      return hasId ? this.error(id, -32600, 'Invalid Request: missing method') : null;
    }

    switch (method) {
      case 'initialize': {
        const params = message.params as { protocolVersion?: unknown } | undefined;
        return this.result(id, {
          protocolVersion: typeof params?.protocolVersion === 'string'
            ? params.protocolVersion
            : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: this.name, version: this.version },
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return this.result(id, {});
      case 'tools/list':
        return this.result(id, { tools: this.toolDescriptors() });
      case 'tools/call':
        return this.callTool(id, message.params);
      default:
        return hasId ? this.error(id, -32601, `Method not found: ${method}`) : null;
    }
  }

  private result(id: JsonRpcId, result: unknown): Record<string, unknown> {
    return { jsonrpc: '2.0', id, result };
  }

  private error(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  private toolDescriptors(): Array<Record<string, unknown>> {
    return Array.from(this.tools.values(), (t) => ({
      name: t.name,
      description: t.description,
      inputSchema: this.inputSchemaFor(t),
    }));
  }

  private inputSchemaFor(t: InProcTool): Record<string, unknown> {
    const cached = this.schemaCache.get(t.name);
    if (cached) return cached;
    let schema: Record<string, unknown>;
    try {
      schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
      delete schema.$schema;
    } catch (err) {
      console.warn(`[inproc-mcp] JSON schema conversion failed for tool '${t.name}':`, err);
      schema = { type: 'object' };
    }
    this.schemaCache.set(t.name, schema);
    return schema;
  }

  private async callTool(id: JsonRpcId, params: unknown): Promise<Record<string, unknown>> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof p.name === 'string' ? p.name : '';
    const t = this.tools.get(toolName);
    if (!t) return this.error(id, -32602, `Unknown tool: ${toolName}`);
    const parsed = t.schema.safeParse(p.arguments ?? {});
    if (!parsed.success) {
      return this.result(id, {
        content: [{ type: 'text', text: `Invalid arguments for ${toolName}: ${parsed.error.message}` }],
        isError: true,
      });
    }
    try {
      return this.result(id, await t.handler(parsed.data as never));
    } catch (err) {
      return this.result(id, {
        content: [{ type: 'text', text: errorMessage(err) }],
        isError: true,
      });
    }
  }
}

/** Mirrors the retired SDK's createSdkMcpServer return shape
 *  (`{ type: 'sdk', name, instance }`) so existing call sites and the
 *  driver's mcpServers splitting keep working unchanged. */
export function createInProcMcpServer(opts: {
  name: string;
  version?: string;
  tools: InProcTool[];
}): { type: 'sdk'; name: string; instance: InProcMcpServer } {
  return {
    type: 'sdk',
    name: opts.name,
    instance: new InProcMcpServerImpl(opts.name, opts.version ?? '0.1.0', opts.tools),
  };
}

/** Alias kept so existing imports read exactly like the SDK era. */
export const createSdkMcpServer = createInProcMcpServer;
