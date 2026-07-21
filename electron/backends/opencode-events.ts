// opencode-events.ts — pure event-pipeline helpers for the OpenCode backend.
//
// Everything here is electron-free and directly unit-testable:
//   - SSE framing (fetch-stream → data frames; the server never sends id:
//     lines, so only data: is consumed — spike §5),
//   - session attribution (which sessionID an event belongs to, or null for
//     instance-level events),
//   - part → NormalizedMessage mapping (text / tool parts),
//   - checkpoint-resync merge: (messageID, partID) last-write-wins.

import type { NormalizedMessage } from './cli-backend.js';

// ── SSE framing ─────────────────────────────────────────────────────────────

export interface SseParser {
  push(chunk: string): void;
}

/** Incremental `text/event-stream` parser over decoded string chunks.
 *  Frames are separated by blank lines (LF or CRLF); multi-line data: fields
 *  concatenate with '\n'; comment lines (':') and non-data fields are
 *  ignored (the server never sends id:/event:/retry: — spike §5). */
export function createSseParser(onFrame: (data: string) => void): SseParser {
  let buf = '';

  const dispatchFrame = (raw: string) => {
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') dataLines.push(value);
    }
    if (dataLines.length > 0) onFrame(dataLines.join('\n'));
  };

  return {
    push(chunk) {
      buf += chunk;
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf);
        if (!m) return;
        dispatchFrame(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
      }
    },
  };
}

// ── Session attribution ─────────────────────────────────────────────────────

/** Extract the sessionID an event belongs to. Returns null for
 *  instance-level events (file.edited, file.watcher.updated,
 *  vcs.branch.updated, lsp.*, pty.*, server.connected, installation.*,
 *  tui.*, server.instance.disposed) which carry no session reference. */
export function extractEventSessionId(type: string, properties: unknown): string | null {
  if (!properties || typeof properties !== 'object') return null;
  const p = properties as Record<string, unknown>;
  switch (type) {
    case 'message.part.updated': {
      const part = p.part as Record<string, unknown> | undefined;
      return (part?.sessionID as string | undefined) ?? null;
    }
    case 'message.updated': {
      const info = p.info as Record<string, unknown> | undefined;
      return (info?.sessionID as string | undefined) ?? null;
    }
    case 'session.created':
    case 'session.updated':
    case 'session.deleted': {
      const info = p.info as Record<string, unknown> | undefined;
      return (info?.id as string | undefined) ?? null;
    }
    default:
      // Direct sessionID carriers: message.removed, message.part.removed,
      // session.idle/status/compacted/diff/error (optional there),
      // permission.updated/replied, todo.updated, command.executed.
      // Instance-level events simply have no sessionID → null.
      return (p.sessionID as string | undefined) ?? null;
  }
}

// ── Part mapping ────────────────────────────────────────────────────────────

/** Map an OpenCode message part to a NormalizedMessage. Text parts become
 *  text blocks, tool parts become tool_use blocks (input read defensively
 *  from state.input, present in every ToolState variant). All other part
 *  types (reasoning, step-*, snapshot, patch, agent, retry, compaction,
 *  subtask, file) return null for now. */
export function mapPartToNormalizedMessage(part: unknown, raw?: unknown): NormalizedMessage | null {
  if (!part || typeof part !== 'object') return null;
  const p = part as Record<string, unknown>;

  if (p.type === 'text') {
    if (typeof p.text !== 'string' || p.text.length === 0) return null;
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: p.text }] },
      raw,
    };
  }

  if (p.type === 'tool') {
    const state = (p.state ?? {}) as Record<string, unknown>;
    const input = (state.input ?? {}) as Record<string, unknown>;
    return {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: typeof p.callID === 'string' ? p.callID : String(p.id ?? ''),
            name: typeof p.tool === 'string' ? p.tool : 'unknown',
            input,
          },
        ],
      },
      raw,
    };
  }

  return null;
}

// ── Checkpoint-resync merge ─────────────────────────────────────────────────

/** Dedupe key for a message part: (messageID, partID). */
export function partKeyOf(part: { messageID?: unknown; id?: unknown }): string | null {
  if (typeof part.messageID !== 'string' || typeof part.id !== 'string') return null;
  return `${part.messageID}:${part.id}`;
}

/** Merge a full snapshot with events buffered during the resync window.
 *  Last-write-wins per (messageID, partID) — buffered events are newer than
 *  the snapshot and overwrite it. Ordering: snapshot order, buffered-only
 *  keys appended in buffer order; keyless parts (cannot dedupe) are kept
 *  last, snapshot first. */
export function mergeResyncParts<T extends { messageID?: unknown; id?: unknown }>(
  snapshotParts: readonly T[],
  bufferedParts: readonly T[],
): T[] {
  const merged = new Map<string, T>();
  const order: string[] = [];
  const keyless: T[] = [];

  for (const part of snapshotParts) {
    const key = partKeyOf(part);
    if (!key) {
      keyless.push(part);
      continue;
    }
    if (!merged.has(key)) order.push(key);
    merged.set(key, part);
  }
  for (const part of bufferedParts) {
    const key = partKeyOf(part);
    if (!key) {
      keyless.push(part);
      continue;
    }
    if (!merged.has(key)) order.push(key);
    merged.set(key, part); // buffered wins on conflict
  }

  return [...order.map((k) => merged.get(k)!), ...keyless];
}
