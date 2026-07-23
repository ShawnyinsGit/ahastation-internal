// decisions.ts — async, suspend-able "request user decision" mechanism.
//
//   The talker hits a fork in the road, picks the highest-recommendation option
//   to keep moving, AND drops a markdown doc into ~/Documents/AhaStation/decisions.
//   That doc lists every option with pros/cons + an empty "✅ 确认结论" section.
//   Calendar.app + Reminders.app entries are spawned via osascript so the user
//   sees a deadline on their phone/laptop. We fs.watch the file: as soon as the
//   user fills in the conclusion section and saves, we parse it back out and
//   notify the orchestrator so the talker can re-evaluate.
//
//   Everything fs / shell-related lives in this module so the renderer (sand-
//   boxed) never has to touch the disk directly.

import { homedir } from 'node:os';
import { join, resolve, isAbsolute, sep } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const CONCLUSION_MARKER = '<!-- conclusion-marker -->';
const FILE_WATCH_DEBOUNCE_MS = 250;

export interface DecisionOption {
  title: string;
  summary: string;
  pros: string[];
  cons: string[];
  /** 1-10. Higher = more strongly recommended. */
  recommendationScore: number;
}

export interface CreateDecisionPayload {
  question: string;
  context?: string;
  options: DecisionOption[];
  /** Epoch ms. Used for both the markdown header and the Calendar/Reminders deadline. */
  deadline: number;
}

export interface CreatedDecision {
  id: string;
  path: string;
  /** The option index (0-based) the host should proceed with right now. */
  recommendedIndex: number;
  /** Echoed payload normalized + frozen. */
  payload: CreateDecisionPayload;
  /** Whether the Calendar/Reminders side-channel succeeded. Failure is non-fatal. */
  calendar: { ok: boolean; error?: string };
  reminders: { ok: boolean; error?: string };
}

export interface ResolvedDecision {
  id: string;
  path: string;
  conclusion: string;
}

/** Public root: ~/Documents/AhaStation/decisions */
export function decisionsRoot(): string {
  return join(homedir(), 'Documents', 'AhaStation', 'decisions');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function timestampSlug(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function questionSlug(question: string): string {
  const cleaned = question
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'decision';
}

function formatLocaleDateTime(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function rankOptions(options: DecisionOption[]): { index: number; option: DecisionOption }[] {
  return options
    .map((option, index) => ({ index, option }))
    .sort((a, b) => b.option.recommendationScore - a.option.recommendationScore);
}

function buildMarkdown(payload: CreateDecisionPayload, id: string): string {
  const ranked = rankOptions(payload.options);
  const created = new Date();
  const deadline = new Date(payload.deadline);

  const optionBlocks = ranked.map(({ option }, i) => {
    const star = i === 0 ? '⭐ ' : '';
    const pros = option.pros.length > 0
      ? option.pros.map((p) => `- 优点：${p}`).join('\n')
      : '- 优点：—';
    const cons = option.cons.length > 0
      ? option.cons.map((c) => `- 缺点：${c}`).join('\n')
      : '- 缺点：—';
    return [
      `### ${i + 1}. ${star}${option.title}  (推荐分: ${option.recommendationScore}/10)`,
      '',
      option.summary,
      '',
      pros,
      cons,
    ].join('\n');
  }).join('\n\n');

  const contextBlock = payload.context
    ? `## 问题\n\n${payload.context}\n`
    : `## 问题\n\n${payload.question}\n`;

  return [
    `# ${payload.question}`,
    '',
    '> 这份决策正在等你拍板。Host 已经按推荐方案先开干了；',
    '> 如果你最终选了别的方案，在下面"✅ 确认结论"区写出你的选择和理由，',
    '> 保存即可，host 会自动接到通知并调整。',
    '',
    `**Created**: ${formatLocaleDateTime(created)}  `,
    `**Deadline**: ${formatLocaleDateTime(deadline)}  `,
    `**Decision id**: \`${id}\``,
    '',
    contextBlock,
    '## 备选方案 (按推荐排序)',
    '',
    optionBlocks,
    '',
    `## ✅ 确认结论 ${CONCLUSION_MARKER}`,
    '',
    '<!-- 在下面写出你最终选定的方案编号或自由文本，保存即可。',
    '     例如：1',
    '     或：1，按推荐方案 + 改一下错误信息 -->',
    '',
    '',
  ].join('\n');
}

/**
 * Extract whatever the user typed in the "✅ 确认结论" section.
 * Strips HTML comments and surrounding whitespace; returns '' if empty.
 */
export function parseConclusion(content: string): string {
  const idx = content.indexOf(CONCLUSION_MARKER);
  if (idx < 0) return '';
  // Take everything after the marker line.
  const after = content.slice(idx + CONCLUSION_MARKER.length);
  // Strip leading newline + heading remainder up to the first newline.
  const newlineIdx = after.indexOf('\n');
  const body = newlineIdx >= 0 ? after.slice(newlineIdx + 1) : after;
  // Remove HTML comments entirely.
  const noComments = body.replace(/<!--[\s\S]*?-->/g, '');
  return noComments.trim();
}

// ---------- AppleScript helpers --------------------------------------------

function escAplStr(s: string): string {
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\t/g, '\\t')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  return '"' + escaped + '"';
}

/**
 * Build an AppleScript snippet that constructs a date object in `varName`
 * field-by-field. We can't use a literal `date "..."` because AppleScript date
 * parsing is locale-dependent and would break on non-en_US machines.
 */
function dateAplProperty(varName: string, d: Date): string {
  return [
    `set ${varName} to current date`,
    `set year of ${varName} to ${d.getFullYear()}`,
    `set month of ${varName} to ${d.getMonth() + 1}`,
    `set day of ${varName} to ${d.getDate()}`,
    `set hours of ${varName} to ${d.getHours()}`,
    `set minutes of ${varName} to ${d.getMinutes()}`,
    `set seconds of ${varName} to 0`,
  ].join('\n');
}

function calendarScript(title: string, notes: string, fileUrl: string, deadline: Date): string {
  const startVar = 'startDate';
  const endVar = 'endDate';
  const start = new Date(deadline.getTime());
  const end = new Date(deadline.getTime() + 30 * 60 * 1000);
  return [
    'tell application "Calendar"',
    `  tell calendar 1`,
    `    ${dateAplProperty(startVar, start).split('\n').join('\n    ')}`,
    `    ${dateAplProperty(endVar, end).split('\n').join('\n    ')}`,
    `    set newEvent to make new event with properties {summary:${escAplStr(title)}, start date:${startVar}, end date:${endVar}, description:${escAplStr(notes)}, url:${escAplStr(fileUrl)}}`,
    '  end tell',
    'end tell',
  ].join('\n');
}

function reminderScript(title: string, notes: string, deadline: Date): string {
  const dueVar = 'dueDate';
  return [
    'tell application "Reminders"',
    '  tell default list',
    `    ${dateAplProperty(dueVar, deadline).split('\n').join('\n    ')}`,
    `    make new reminder with properties {name:${escAplStr(title)}, body:${escAplStr(notes)}, due date:${dueVar}}`,
    '  end tell',
    'end tell',
  ].join('\n');
}

function runOsascript(script: string): Promise<{ ok: boolean; error?: string }> {
  // Calendar.app and Reminders.app integration is macOS-only (JXA/osascript).
  // On other platforms, skip gracefully — the decision markdown file is
  // still written, just without the calendar/reminder side-channel.
  if (process.platform !== 'darwin') {
    return Promise.resolve({ ok: false, error: 'Calendar/Reminders integration requires macOS' });
  }
  return new Promise((resolveP) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err: Error) => {
      resolveP({ ok: false, error: err.message });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolveP({ ok: true });
      } else {
        resolveP({ ok: false, error: stderr.trim() || `osascript exited ${code}` });
      }
    });
  });
}

// ---------- Public API ------------------------------------------------------

export async function createDecisionDoc(payload: CreateDecisionPayload): Promise<CreatedDecision> {
  const root = decisionsRoot();
  await mkdir(root, { recursive: true });

  const id = randomUUID();
  const created = new Date();
  const slug = questionSlug(payload.question);
  const filename = `${timestampSlug(created)}-${slug}.md`;
  const path = join(root, filename);

  const body = buildMarkdown(payload, id);
  await writeFile(path, body, 'utf8');

  const ranked = rankOptions(payload.options);
  const recommendedIndex = ranked[0]?.index ?? 0;

  const fileUrl = `file://${encodeURI(path)}`;
  const deadline = new Date(payload.deadline);
  const summary = ranked[0]
    ? `推荐方案：${ranked[0].option.title}`
    : '请尽快确认';
  const calendarTitle = `AhaStation 待确认：${payload.question}`.slice(0, 200);
  const reminderTitle = calendarTitle;
  const notes = `${summary}\n\n详情: ${path}\n${fileUrl}`;

  // Best-effort. Failure here just means the user won't get the OS-level
  // nudge; the markdown doc + in-app activity entry still work.
  const calendar = await runOsascript(calendarScript(calendarTitle, notes, fileUrl, deadline));
  const reminders = await runOsascript(reminderScript(reminderTitle, notes, deadline));

  return {
    id,
    path,
    recommendedIndex,
    payload,
    calendar,
    reminders,
  };
}

/**
 * Validate that `path` lives inside `decisionsRoot()`. Used by IPC handlers
 * to reject renderer-side malicious paths.
 */
export function isInsideDecisionsRoot(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const root = resolve(decisionsRoot());
  const target = resolve(path);
  // Use platform-aware separator (sep is '/' on Unix, '\' on Windows)
  return target === root || target.startsWith(root + sep);
}

interface WatchEntry {
  path: string;
  watcher: FSWatcher;
  debounceTimer: NodeJS.Timeout | null;
  lastConclusion: string;
  onResolve: (r: ResolvedDecision) => void;
  id: string;
  disposed: boolean;
}

export class DecisionWatcher {
  private entries: Map<string, WatchEntry> = new Map();

  /**
   * Start watching `path`. Fires `onResolve` once whenever the conclusion
   * section transitions from empty → non-empty OR changes after being non-
   * empty (user changing their mind is supported).
   */
  watch(id: string, path: string, onResolve: (r: ResolvedDecision) => void): void {
    if (this.entries.has(path)) return;

    let watcher: FSWatcher;
    try {
      watcher = watch(path, { persistent: false }, () => this.scheduleCheck(path));
    } catch (err) {
      console.warn('[decisions] fs.watch failed for', path, err);
      return;
    }

    const entry: WatchEntry = {
      id,
      path,
      watcher,
      debounceTimer: null,
      lastConclusion: '',
      onResolve,
      disposed: false,
    };
    this.entries.set(path, entry);

    watcher.on('error', (err: Error) => {
      console.warn('[decisions] watcher error for', path, err.message);
    });
  }

  unwatch(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    entry.disposed = true;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    try { entry.watcher.close(); } catch { /* ignore */ }
    this.entries.delete(path);
  }

  dispose(): void {
    for (const path of [...this.entries.keys()]) this.unwatch(path);
  }

  private scheduleCheck(path: string): void {
    const entry = this.entries.get(path);
    if (!entry || entry.disposed) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.checkOnce(path);
    }, FILE_WATCH_DEBOUNCE_MS);
  }

  private async checkOnce(path: string): Promise<void> {
    const entry = this.entries.get(path);
    if (!entry || entry.disposed) return;
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      // File might've been deleted; just stop watching it.
      this.unwatch(path);
      return;
    }
    const conclusion = parseConclusion(content);
    if (!conclusion) return;
    if (conclusion === entry.lastConclusion) return;
    entry.lastConclusion = conclusion;
    try {
      entry.onResolve({ id: entry.id, path, conclusion });
    } catch (err) {
      console.warn('[decisions] onResolve threw for', path, err);
    }
  }
}
