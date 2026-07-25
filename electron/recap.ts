// recap.ts — best-effort end-of-meeting recap pass.
//
// Run once after the user leaves a meeting. Feeds the talker transcript to
// a Haiku query with no tools / no MCP, asks for a JSON array of memorable
// items, then funnels parsed items through the same `appendEntry` validation
// (secret patterns, length caps) used by the live save_memory tool path.
//
// Returns a handle so the orchestrator can abort the recap if the user
// presses interrupt after `end()` was called.

import { query } from './claude-cli/driver.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendEntry } from './memory.js';
import { ensureDir, maybeAppendGitignore } from './attachments/workspace.js';
import { extractText, RECAP_MIN_TRANSCRIPT_ENTRIES, RECAP_TRANSCRIPT_CHAR_CAP } from './orchestrator-helpers.js';
import { RECAP_PROMPT } from './orchestrator-prompts.js';
import { mergedSubprocessEnv } from './settings-loader.js';
import type { MemoryCategory } from './memory.js';
import type { TalkerTurn } from './orchestrator-types.js';

export interface RecapOpts {
  transcript: TalkerTurn[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  projectId: string;
  meetingId: string;
}

export interface RecapHandle {
  /** Resolves when the recap finishes (success, abort, or failure). Never
   *  rejects — all errors are logged and swallowed so callers can `void` it. */
  done: Promise<void>;
  /** Cancel an in-flight recap. Safe to call multiple times. */
  abort: () => Promise<void>;
  /** True until the recap promise resolves. */
  isActive: () => boolean;
}

const RECAP_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
  'point',
  'decision',
  'todo',
  'fact',
]);

/** Kick off a recap pass. Returns null if the transcript is too short to be
 *  worth summarising. */
export function startRecap(opts: RecapOpts): RecapHandle | null {
  if (opts.transcript.length < RECAP_MIN_TRANSCRIPT_ENTRIES) return null;

  let activeQuery: ReturnType<typeof query> | null = null;
  let aborted = false;
  let active = true;

  const done = (async () => {
    try {
      await runRecap(opts, (q) => { activeQuery = q; }, () => aborted);
    } catch (err) {
      console.error('[memory] recap failed:', err);
      // User won't see a recap file, but the error is logged for debugging.
      // Future: could emit an event to surface this in the UI.
    } finally {
      active = false;
      activeQuery = null;
    }
  })();

  return {
    done,
    abort: async () => {
      aborted = true;
      const q = activeQuery;
      if (q) {
        try { await q.interrupt(); } catch { /* ignore */ }
      }
    },
    isActive: () => active,
  };
}

async function runRecap(
  opts: RecapOpts,
  registerQuery: (q: ReturnType<typeof query>) => void,
  isAborted: () => boolean,
): Promise<void> {
  // Stitch the transcript into a single user message, capping the tail so
  // we stay well under Haiku's context window.
  const joined = opts.transcript
    .map((t) => `${t.role === 'user' ? '用户' : '助手'}: ${t.text}`)
    .join('\n');
  const trimmed =
    joined.length > RECAP_TRANSCRIPT_CHAR_CAP
      ? joined.slice(joined.length - RECAP_TRANSCRIPT_CHAR_CAP)
      : joined;

  let responseText = '';
  const env = opts.env ?? mergedSubprocessEnv();
  const q = query({
    prompt: (async function* () {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: trimmed },
        parent_tool_use_id: null,
      };
    })(),
    options: {
      cwd: opts.cwd,
      // Respect an explicit ANTHROPIC_MODEL (app override or settings.json /
      // custom gateway) — a hardcoded haiku id is rejected by gateways that
      // only map the configured model. Falls back to haiku when unset.
      model: env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
      systemPrompt: RECAP_PROMPT,
      tools: [],
      mcpServers: {},
      skills: [],
      settingSources: [],
      permissionMode: 'default',
      env,
    },
  });
  registerQuery(q);
  try {
    for await (const msg of q) {
      if (isAborted()) break;
      const m: any = msg;
      if (m?.type === 'assistant') {
        const text = extractText(m);
        if (text) responseText += `${text}\n`;
      }
    }
  } finally {
    try { q.interrupt().catch(() => { /* ignore */ }); } catch { /* ignore */ }
  }

  if (isAborted()) return;

  // Locate the JSON array in the response. Haiku usually obeys "no markdown"
  // but defensive parsing here is cheap insurance.
  const start = responseText.indexOf('[');
  const end = responseText.lastIndexOf(']');
  if (start < 0 || end <= start) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText.slice(start, end + 1));
  } catch (err) {
    console.warn('[memory] recap JSON parse failed:', err);
    return;
  }
  if (!Array.isArray(parsed)) return;

  let saved = 0;
  const minutesItems: Array<{ category: MemoryCategory; content: string }> = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const category = r.category;
    const content = r.content;
    const tags = Array.isArray(r.tags)
      ? (r.tags as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (
      typeof category !== 'string' ||
      !RECAP_CATEGORIES.has(category as MemoryCategory) ||
      typeof content !== 'string' ||
      content.trim().length === 0
    ) {
      continue;
    }
    minutesItems.push({ category: category as MemoryCategory, content: content.trim() });
    const result = await appendEntry({
      category: category as MemoryCategory,
      content,
      tags,
      projectId: opts.projectId,
      sourceMeetingId: opts.meetingId,
    });
    if (result.ok) saved += 1;
  }
  console.log(`[memory] recap saved ${saved} entries from meeting ${opts.meetingId}`);

  void writeMinutes(opts, minutesItems);
}

const MINUTES_DIR = '.vibe-minutes';
const TRANSCRIPT_TAIL = 50;
const TRANSCRIPT_LINE_CAP = 200;

async function writeMinutes(
  opts: RecapOpts,
  items: Array<{ category: MemoryCategory; content: string }>,
): Promise<void> {
  try {
    const dir = await ensureDir(opts.cwd, MINUTES_DIR);
    if (!dir) return;

    const now = new Date();
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const shortId = opts.meetingId.slice(0, 8);
    const filename = `${dateStr}-${shortId}.md`;

    const sections: Record<MemoryCategory, string[]> = {
      decision: [],
      todo: [],
      point: [],
      fact: [],
    };
    for (const item of items) {
      sections[item.category].push(`- ${item.content}`);
    }

    const lines: string[] = [`# 会议纪要 — ${dateStr}`, ''];
    if (sections.decision.length > 0) {
      lines.push('## 决策', ...sections.decision, '');
    }
    if (sections.todo.length > 0) {
      lines.push('## 待办', ...sections.todo, '');
    }
    if (sections.point.length > 0) {
      lines.push('## 要点', ...sections.point, '');
    }
    if (sections.fact.length > 0) {
      lines.push('## 事实', ...sections.fact, '');
    }

    const tail = opts.transcript.slice(-TRANSCRIPT_TAIL);
    if (tail.length > 0) {
      lines.push('---', '', '## 对话摘要', '');
      for (const t of tail) {
        const role = t.role === 'user' ? '用户' : '助手';
        const text = t.text.length > TRANSCRIPT_LINE_CAP
          ? `${t.text.slice(0, TRANSCRIPT_LINE_CAP)}…`
          : t.text;
        lines.push(`**${role}**: ${text}`, '');
      }
    }

    await fs.writeFile(path.join(dir, filename), lines.join('\n'), 'utf8');
    await maybeAppendGitignore(opts.cwd, MINUTES_DIR);
    console.log(`[minutes] wrote ${filename}`);
  } catch (err) {
    console.error('[minutes] writeMinutes failed:', err);
    // Re-throw so caller knows minutes weren't saved
    throw new Error(`Failed to write minutes: ${err instanceof Error ? err.message : String(err)}`);
  }
}
