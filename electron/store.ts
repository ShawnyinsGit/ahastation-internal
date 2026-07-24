// store.ts — tiny JSON settings store backed by userData/settings.json.
//
// Used for things that should survive app restarts but aren't worth a full DB:
// recent cwds for the Lobby, open tab list for cold-restart, voice-print
// enrollment, voice-lock toggle, etc.
//
// Reads stay synchronous (cache hit after first load) so call sites that just
// need to look up `selectedVoiceName` etc. don't have to thread async through
// the world.
//
// Writes are async + atomic (`fs.promises.writeFile` to a temp file +
// `fs.promises.rename`). All writes are funneled through a single tail-promise
// queue so two concurrent updates can't race on the rename — same pattern as
// memory.ts. Use `flushSettingsWrites()` on shutdown to wait for the queue
// to drain so `before-quit` can't return before the last openTabs snapshot
// hits disk.

import { app, dialog, safeStorage } from 'electron';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

export interface VoicePrint {
  // Float32 embedding flattened into a regular number[] for JSON.
  embedding: number[];
  // Model identifier so we can invalidate enrollments when the model changes.
  model: string;
  // Seconds of speech the enrollment was averaged over (UI feedback).
  secondsCaptured: number;
  enrolledAt: number;
}

export interface RecentCwdEntry {
  path: string;
  lastOpenedAt: number;
}

export interface OpenTabEntry {
  cwd: string;
  openedAt: number;
}

export interface BackendAuthEntry {
  backendId: string;  // 'claude-code' | 'codex' | 'kimi' | 'qoder' | custom ID
  authMode: 'apikey' | 'oauth' | 'none';
  apiKeyEnc?: string;  // base64 of safeStorage.encryptString(apiKey)
  apiKey?: string;     // plaintext in memory only, never written to disk when encryption available
  baseUrl?: string;
  model?: string;
  lastValidatedAt?: number;  // timestamp of last successful auth check
  /** Custom avatar image as base64 data URL (e.g. 'data:image/png;base64,...'). */
  customAvatar?: string;
}

export interface CustomBackendEntry {
  id: string;
  displayName: string;
  binaryName: string;
  apiKeyEnv?: string;      // e.g. "OPENAI_API_KEY"
  baseUrlEnv?: string;     // e.g. "OPENAI_BASE_URL"
  defaultModel?: string;
  installHint?: string;
  npmPackage?: string;
  createdAt: number;
}

export type AsrProvider = 'local' | 'cloud';

export interface CloudAsrSettings {
  /** OpenAI-compatible API root, e.g. https://api.openai.com/v1 or
   *  https://api.groq.com/openai/v1. Empty = built-in default (OpenAI). */
  baseUrl?: string;
  /** Bearer key for the cloud endpoint. Never logged; persisted in
   *  settings.json like other non-Anthropic credentials. */
  apiKey?: string;
  /** Model name sent in the multipart form. Empty = 'whisper-1'. */
  model?: string;
}

export interface Settings {
  /** @deprecated Migrated into recentCwds + lastActiveCwd at first load. Kept
   *  in the type so JSON files written by old versions parse without warnings. */
  lastCwd?: string;
  /** LRU of directories the user has ever opened a meeting in. Newest first.
   *  Capped at RECENT_CWDS_MAX to keep settings.json bounded. */
  recentCwds?: RecentCwdEntry[];
  /** Tabs that were open last time the app quit. The renderer uses this on
   *  cold start to draw placeholder tabs without spawning Orchestrators. */
  openTabs?: OpenTabEntry[];
  /** The cwd of the focused tab at last quit, so cold restart can auto-focus
   *  the right placeholder. */
  lastActiveCwd?: string | null;
  voiceLockEnabled?: boolean;
  voicePrint?: VoicePrint;
  // null = "auto" (let rankVoice pick). A string overrides the picker with
  // the user's explicit choice; we match by SpeechSynthesisVoice.name.
  selectedVoiceName?: string | null;
  // Once the user dismisses the one-shot "go download Siri voices" guide
  // with "don't show again", we stop nagging — even if they later remove
  // the premium voices, they made their choice.
  voiceGuidanceDismissed?: boolean;
  // TTS noise filter: 'strict' drops English-only sentences and worker
  // tool-call narration before playback (default); 'off' speaks raw.
  speechFilterMode?: 'strict' | 'off';
  // Report mode: when true, the talker is instructed to save long responses
  // as documents and only speak a 2-3 sentence conversational summary. The
  // full document is displayed in the UI for review. Default off.
  reportModeEnabled?: boolean;
  // Handheld UI mode (§3.3): 'auto' (default — (pointer:coarse) &&
  // screen.width ≤ 1300 decides), 'handheld' or 'desktop' to force. Layout
  // is driven by a root class from the resolved mode, not width breakpoints.
  handheldMode?: 'auto' | 'handheld' | 'desktop';
  // 24h cache for the pragmatic update probe (electron/update-check.ts).
  // latest=null records "checked, nothing found" so we don't re-probe.
  updateCheckCache?: { checkedAt: number; latest: string | null };
  // Companion screen sound effects (§3.4): default ON; the companion
  // window can mute them. TTS activity always ducks them regardless.
  companionSoundEnabled?: boolean;
  // Voice polish: when true, raw ASR output is run through the configured LLM
  // to convert colloquial spoken language into clean written form before
  // sending to the Talker. Uses the same API credentials as the rest of the
  // app. Persists via settings:get/set-voice-pref.
  voicePolishEnabled?: boolean;
  // ASR provider: 'local' (default) runs the bundled whisper.cpp binary;
  // 'cloud' POSTs segments to an OpenAI-compatible /audio/transcriptions
  // endpoint instead — for hosts that can't run local inference (RK3588 /
  // glibc 2.31) or users who want a hosted model. Persisted via
  // settings:get/set-voice-pref.
  asrProvider?: AsrProvider;
  cloudAsr?: CloudAsrSettings;
  // Claude authentication: 'apikey' uses a manually-entered API key;
  // 'subscription' relies on the claude CLI's own OAuth credentials.
  authMode?: 'apikey' | 'subscription';
  // Manually entered Anthropic API key. Only used when authMode === 'apikey'.
  // Held in memory as plaintext, but persisted to disk encrypted via
  // `anthropicApiKeyEnc` (Electron safeStorage / OS keychain). The plaintext
  // field is never written to settings.json when encryption is available.
  anthropicApiKey?: string;
  // Base64 of safeStorage.encryptString(anthropicApiKey). This is the on-disk
  // form; load() decrypts it back into `anthropicApiKey` and drops this field
  // from the in-memory cache. Present in the type only so JSON round-trips.
  anthropicApiKeyEnc?: string;
  // Custom gateway base URL (ANTHROPIC_BASE_URL). Only injected when
  // authMode === 'apikey'. Empty/undefined falls back to settings.json env.
  anthropicBaseUrl?: string;
  // Model override (ANTHROPIC_MODEL) for talker + workers. Only injected when
  // authMode === 'apikey'. Empty/undefined uses CLI/built-in defaults.
  anthropicModel?: string;
  /** Per-backend auth configurations. When present, takes priority over the
   *  legacy authMode/anthropicApiKey fields. Migration runs on first load
   *  to promote legacy auth into backendAuth[0] for 'claude-code'. */
  backendAuth?: BackendAuthEntry[];
  /** Default backend ID for new sessions. Falls back to 'claude-code' if unset. */
  defaultBackend?: string;
  /** User-defined custom CLI backends. Each entry is registered as a
   *  CustomBackend at app startup so it appears in the backend list and
   *  can be invited to meetings like any built-in backend. */
  customBackends?: CustomBackendEntry[];
}

const RECENT_CWDS_MAX = 10;

let cached: Settings | null = null;
let cachedPath: string | null = null;

// --- API key at-rest encryption (S2) ----------------------------------------
// safeStorage is backed by the OS keychain (Keychain on macOS). It returns
// false before app `ready` on some platforms, so every call is guarded — a
// failure degrades to "key absent this session" rather than crashing, and we
// never wipe an existing ciphertext we couldn't read.

function safeStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function tryEncryptKey(plain: string): string | null {
  try {
    if (!safeStorageAvailable()) return null;
    return safeStorage.encryptString(plain).toString('base64');
  } catch (err) {
    console.warn('[store] safeStorage encrypt failed; key will remain memory-only:', err);
    return null;
  }
}

function tryDecryptKey(b64: string): string | null {
  try {
    if (!safeStorageAvailable()) return null;
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch (err) {
    console.warn('[store] safeStorage decrypt failed; API key unavailable this session:', err);
    return null;
  }
}

// Map an in-memory Settings (plaintext-key convention) onto its on-disk form:
// the API key is written encrypted, never as plaintext, whenever safeStorage
// is available.
function toDiskForm(s: Settings): Settings {
  const { anthropicApiKey, anthropicApiKeyEnc, ...rest } = s;
  const backendAuth = rest.backendAuth?.map((entry) => {
    const { apiKey, apiKeyEnc, ...safe } = entry;
    if (apiKey) {
      const encrypted = tryEncryptKey(apiKey);
      return encrypted ? { ...safe, apiKeyEnc: encrypted } : safe;
    }
    return apiKeyEnc ? { ...safe, apiKeyEnc } : safe;
  });
  const safeRest: Settings = backendAuth ? { ...rest, backendAuth } : rest;
  if (anthropicApiKey) {
    const enc = tryEncryptKey(anthropicApiKey);
    // safeStorage down → keep the key in memory only. Persisting plaintext is
    // never an acceptable silent fallback.
    return enc ? { ...safeRest, anthropicApiKeyEnc: enc } : safeRest;
  }
  // No plaintext in memory — preserve any pre-existing ciphertext (e.g. a blob
  // we couldn't decrypt this session) so a routine write doesn't erase it.
  return anthropicApiKeyEnc ? { ...safeRest, anthropicApiKeyEnc } : safeRest;
}

// Single tail-promise chain; mirrors the pattern in memory.ts. Errors are
// swallowed locally so one bad write doesn't poison the chain — individual
// write functions still get the original rejection via `next`.
let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = writeQueue.then(() => fn());
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** Resolves once the in-flight write queue has drained. Call from
 *  `before-quit` so the last openTabs snapshot is on disk before exit. */
export function flushSettingsWrites(): Promise<void> {
  return writeQueue.then(
    () => undefined,
    () => undefined,
  );
}

function settingsPath(): string {
  if (cachedPath) return cachedPath;
  cachedPath = join(app.getPath('userData'), 'settings.json');
  return cachedPath;
}

function load(): Settings {
  if (cached) return cached;
  const p = settingsPath();
  if (!existsSync(p)) {
    cached = {};
    return cached;
  }
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    cached = typeof parsed === 'object' && parsed !== null ? (parsed as Settings) : {};
  } catch (err) {
    console.error('[store] failed to parse settings.json, starting fresh:', err);
    const bakPath = `${p}.bak`;
    try {
      renameSync(p, bakPath);
      console.warn(`[store] corrupt settings.json backed up to ${bakPath}`);
    } catch (bakErr) {
      console.error('[store] could not back up corrupt settings.json:', bakErr);
    }
    cached = {};
    app.whenReady().then(() => {
      dialog.showMessageBox({
        type: 'warning',
        title: '配置文件损坏',
        message: '设置文件解析失败，已恢复为默认设置。',
        detail: `损坏的配置已备份至：${bakPath}`,
        buttons: ['确定'],
      }).catch(() => {});
    });
  }
  // One-shot migration: pre-multi-tab versions only kept lastCwd. Promote it
  // into recentCwds so the Lobby has something to show, then drop the field
  // (recentCwds + lastActiveCwd subsume it). Idempotent: if recentCwds is
  // already populated the migration is a no-op. Fire-and-forget the persist
  // — `load()` callers don't want to await migration on every cache miss.
  let needsRewrite = false;
  if (cached.lastCwd && (!cached.recentCwds || cached.recentCwds.length === 0)) {
    const migrated: Settings = {
      ...cached,
      recentCwds: [{ path: cached.lastCwd, lastOpenedAt: Date.now() }],
      lastActiveCwd: cached.lastCwd,
    };
    delete migrated.lastCwd;
    cached = migrated;
    needsRewrite = true;
  }
  // Decrypt the at-rest API key into the in-memory plaintext field so every
  // existing reader (settings-loader, auth) keeps seeing `anthropicApiKey`
  // unchanged. A legacy plaintext key on disk (no ciphertext) is migrated to
  // encrypted form on the next write.
  const hadPlaintextKeyOnDisk =
    typeof cached.anthropicApiKey === 'string' &&
    cached.anthropicApiKey.length > 0 &&
    !cached.anthropicApiKeyEnc;
  if (cached.anthropicApiKeyEnc) {
    const dec = tryDecryptKey(cached.anthropicApiKeyEnc);
    if (dec !== null) {
      cached.anthropicApiKey = dec;
      delete cached.anthropicApiKeyEnc;
    }
  }
  if (hadPlaintextKeyOnDisk && safeStorageAvailable()) needsRewrite = true;
  // One-shot migration: promote legacy auth fields into backendAuth array.
  // If backendAuth doesn't exist yet but legacy auth fields do, create a
  // 'claude-code' entry from them. Idempotent: skips if backendAuth already
  // has a 'claude-code' entry.
  if (!cached.backendAuth || cached.backendAuth.length === 0) {
    if (cached.authMode || cached.anthropicApiKey || cached.anthropicBaseUrl || cached.anthropicModel) {
      const claudeEntry: BackendAuthEntry = {
        backendId: 'claude-code',
        authMode: cached.authMode === 'subscription' ? 'oauth' : (cached.authMode ?? 'none'),
        apiKey: cached.anthropicApiKey,
        baseUrl: cached.anthropicBaseUrl,
        model: cached.anthropicModel,
      };
      if (claudeEntry.apiKey && safeStorageAvailable()) {
        const enc = tryEncryptKey(claudeEntry.apiKey);
        if (enc) {
          claudeEntry.apiKeyEnc = enc;
          delete claudeEntry.apiKey;
        }
      }
      cached = {
        ...cached,
        backendAuth: [claudeEntry],
        defaultBackend: 'claude-code',
      };
      needsRewrite = true;
    }
  }
  // One fire-and-forget rewrite covers both migrations so two concurrent
  // persist() calls can't race on the rename.
  if (needsRewrite) {
    void persist({ ...cached }).catch((err) => {
      console.error('[store] migration write failed:', err);
    });
  }
  return cached;
}

async function persist(next: Settings): Promise<void> {
  const p = settingsPath();
  await fsp.mkdir(dirname(p), { recursive: true });
  // Encrypt the API key for the on-disk copy; the in-memory cache keeps the
  // plaintext convention so readers don't have to decrypt.
  const onDisk = toDiskForm(next);
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(onDisk, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, p);
  // Cache flips only after the rename succeeds — if write/rename throws we
  // keep the prior cache so the rest of the app sees a coherent value.
  cached = next;
}

export function getSettings(): Settings {
  return { ...load() };
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return withWriteLock(async () => {
    const next = { ...load(), ...patch };
    // Explicit key clear: also drop any ciphertext we couldn't decrypt this
    // session, otherwise a stale blob would survive a "clear" and toDiskForm
    // would faithfully re-persist it.
    if ('anthropicApiKey' in patch && !patch.anthropicApiKey) {
      delete next.anthropicApiKey;
      delete next.anthropicApiKeyEnc;
    }
    await persist(next);
    return { ...next };
  });
}

export function clearVoicePrint(): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const { voicePrint: _vp, ...rest } = current;
    await persist(rest);
    return { ...rest };
  });
}

/** Upsert a cwd into the LRU. Bumps existing entries to the top instead of
 *  duplicating. Cap at RECENT_CWDS_MAX to keep the file bounded — only the
 *  Lobby renders this list, no one needs an unbounded scroll. */
export function pushRecentCwd(cwd: string): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const now = Date.now();
    const existing = (current.recentCwds ?? []).filter((r) => r.path !== cwd);
    const next: Settings = {
      ...current,
      recentCwds: [{ path: cwd, lastOpenedAt: now }, ...existing].slice(0, RECENT_CWDS_MAX),
    };
    await persist(next);
    return { ...next };
  });
}

/** Replace the openTabs + lastActiveCwd atomically. Called on every tab
 *  open/close/setActive so a sudden quit still restores accurately. */
export function setOpenTabs(tabs: OpenTabEntry[], activeCwd: string | null): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const next: Settings = {
      ...current,
      openTabs: tabs.map((t) => ({ cwd: t.cwd, openedAt: t.openedAt })),
      lastActiveCwd: activeCwd,
    };
    await persist(next);
    return { ...next };
  });
}

/** Get the backend auth entry for a specific backend ID. Returns undefined if
 *  the backend has no auth configuration yet. Decrypts the API key from the
 *  ciphertext field if safeStorage is available. */
export function getBackendAuth(backendId: string): BackendAuthEntry | undefined {
  const settings = load();
  const entry = (settings.backendAuth ?? []).find((e) => e.backendId === backendId);
  if (!entry) return undefined;
  // Decrypt the at-rest API key into the plaintext field for the caller.
  const result = { ...entry };
  if (result.apiKeyEnc) {
    const dec = tryDecryptKey(result.apiKeyEnc);
    if (dec !== null) {
      result.apiKey = dec;
    }
    delete result.apiKeyEnc;
  }
  return result;
}

/** List all backend auth entries. Decrypts API keys in each entry. */
export function listBackendAuth(): BackendAuthEntry[] {
  const settings = load();
  return (settings.backendAuth ?? []).map((entry) => {
    const result = { ...entry };
    if (result.apiKeyEnc) {
      const dec = tryDecryptKey(result.apiKeyEnc);
      if (dec !== null) {
        result.apiKey = dec;
      }
      delete result.apiKeyEnc;
    }
    return result;
  });
}

/** Upsert a backend auth entry. Creates a new entry if the backendId doesn't
 *  exist, or merges the patch into the existing entry. Encrypts the API key
 *  for at-rest storage if safeStorage is available. */
export function setBackendAuth(
  backendId: string,
  patch: Partial<Omit<BackendAuthEntry, 'backendId'>>,
): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const entries = [...(current.backendAuth ?? [])];
    const idx = entries.findIndex((e) => e.backendId === backendId);

    const base: BackendAuthEntry = idx >= 0 ? { ...entries[idx] } : { backendId, authMode: 'none' };
    const updated: BackendAuthEntry = { ...base, ...patch };

    // Encrypt API key for at-rest storage.
    if (updated.apiKey && safeStorageAvailable()) {
      const enc = tryEncryptKey(updated.apiKey);
      if (enc) {
        updated.apiKeyEnc = enc;
        delete updated.apiKey;
      }
    }

    if (idx >= 0) {
      entries[idx] = updated;
    } else {
      entries.push(updated);
    }

    const next: Settings = { ...current, backendAuth: entries };
    await persist(next);
    return { ...next };
  });
}

/** Remove a backend auth entry. */
export function removeBackendAuth(backendId: string): Promise<Settings> {
  return withWriteLock(async () => {
    const current = load();
    const entries = (current.backendAuth ?? []).filter((e) => e.backendId !== backendId);
    const next: Settings = { ...current, backendAuth: entries };
    await persist(next);
    return { ...next };
  });
}

/** Set the default backend for new sessions. */
export function setDefaultBackend(backendId: string): Promise<Settings> {
  return updateSettings({ defaultBackend: backendId });
}

// ── Custom backend CRUD ──────────────────────────────────────────────────────

/** List all custom backend entries. */
export function listCustomBackends(): CustomBackendEntry[] {
  return getSettings().customBackends ?? [];
}

/** Add a new custom backend. Returns the created entry. */
export function addCustomBackend(
  entry: Omit<CustomBackendEntry, 'createdAt'>,
): Promise<{ ok: true; entry: CustomBackendEntry } | { ok: false; error: string }> {
  return withWriteLock(async () => {
    const current = load();
    const list = current.customBackends ?? [];
    // Check for duplicate ID
    if (list.some((b) => b.id === entry.id)) {
      return { ok: false, error: `Custom backend "${entry.id}" already exists` };
    }
    // Validate ID format
    if (!/^[a-zA-Z0-9._-]{1,64}$/.test(entry.id)) {
      return { ok: false, error: 'ID must be alphanumeric with dots/hyphens/underscores, max 64 chars' };
    }
    const created: CustomBackendEntry = { ...entry, createdAt: Date.now() };
    const next: Settings = { ...current, customBackends: [...list, created] };
    await persist(next);
    return { ok: true, entry: created };
  });
}

/** Update a custom backend entry. */
export function updateCustomBackend(
  id: string,
  patch: Partial<Omit<CustomBackendEntry, 'id' | 'createdAt'>>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withWriteLock(async () => {
    const current = load();
    const list = current.customBackends ?? [];
    const idx = list.findIndex((b) => b.id === id);
    if (idx < 0) {
      return { ok: false, error: `Custom backend "${id}" not found` };
    }
    const updated = [...list];
    updated[idx] = { ...updated[idx], ...patch };
    const next: Settings = { ...current, customBackends: updated };
    await persist(next);
    return { ok: true };
  });
}

/** Remove a custom backend. */
export function removeCustomBackend(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return withWriteLock(async () => {
    const current = load();
    const list = current.customBackends ?? [];
    const next: Settings = {
      ...current,
      customBackends: list.filter((b) => b.id !== id),
    };
    await persist(next);
    return { ok: true };
  });
}

