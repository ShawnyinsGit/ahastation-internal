// backend-auth.ts — IPC handlers for per-backend auth configuration.
//
// Each CLI backend (Claude Code, Codex, Kimi, Qoder) has its own auth state.
// These handlers manage the backendAuth array in settings.json, which stores
// per-backend API keys (encrypted), base URLs, models, and auth modes.

import { ipcMain, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  getBackendAuth,
  listBackendAuth,
  setBackendAuth,
  removeBackendAuth,
  setDefaultBackend,
  getSettings,
  updateSettings,
  listCustomBackends,
  addCustomBackend,
  updateCustomBackend,
  removeCustomBackend,
} from '../store.js';
import {
  assessConfiguredWorkerRuntime,
  probeWorkerRuntimeVersion,
  FIRST_RELEASE_STABLE_WORKERS,
} from '../backends/worker-runtime-contract.js';
import {
  getClaudeCodeCliSource,
  resolveClaudeBundledBinary,
  resolveClaudeCliBinary,
  type ClaudeCodeCliSource,
} from '../claude-cli/resolve.js';
import { getBackendRegistry, registerCustomBackends } from '../backends/registry.js';
import { resolveDefaultWorkerBackendId } from '../worker-backend-default.js';
import { augmentedPath } from '../backends/subprocess-backend.js';
import { isolatedSubprocessEnv } from '../backends/backend-environment.js';
import type { BackendAuthEntry } from '../store.js';

/** One install at a time — prevents double-click races from stacking npm
 *  processes that fight over the same global node_modules lock. */
let activeInstall: { backendId: string; proc: ReturnType<typeof spawn> } | null = null;

/** Build a subprocess env using the same allowlist as the Claude SDK session
 *  (see settings-loader.ts). Previously spread all of process.env, which
 *  leaked AWS_*, GITHUB_TOKEN, DATABASE_URL, etc. into `npm install -g` and
 *  `curl | bash` subprocesses — particularly dangerous for the Kimi install
 *  which pipes a remote script into a shell. */
function installEnv(): NodeJS.ProcessEnv {
  const env = isolatedSubprocessEnv();
  // Ensure augmented PATH so npm can find node and freshly-installed
  // binaries land in a location resolveBinaryFromPath() can discover.
  env.PATH = augmentedPath();
  if (!env.LANG) env.LANG = 'en_US.UTF-8';
  return env;
}

/** npm lives at different places depending on how Node was installed.
 *  Check the common absolute paths before falling back to bare `npm` (which
 *  relies on the inherited PATH, unreliable from a .app bundle). */
function resolveNpmBinary(): string {
  if (process.platform === 'win32') {
    // Windows: check APPDATA/npm and Program Files
    const candidates = [
      process.env.APPDATA ? `${process.env.APPDATA}\\npm\\npm.cmd` : null,
      'C:\\Program Files\\nodejs\\npm.cmd',
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return 'npm.cmd';
  }
  // macOS/Linux: check common npm locations
  const candidates = ['/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm'];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'npm';
}

export function registerBackendAuthIpc(): void {
  /** Validate that a backendId corresponds to a registered backend. */
  function validateBackendId(backendId: string): string | null {
    if (!backendId || !/^[a-zA-Z0-9._-]{1,64}$/.test(backendId)) {
      return 'backendId must be alphanumeric with dots/hyphens/underscores, max 64 chars';
    }
    if (!getBackendRegistry().get(backendId)) {
      return `unknown backend: ${backendId}`;
    }
    return null;
  }

  /** List all backends with their auth status and availability. */
  ipcMain.handle('backend-auth:list', async () => {
    const registry = getBackendRegistry();
    const authEntries = listBackendAuth();
    const defaultBackend = getSettings().defaultBackend ?? 'claude-code';
    const claudeCodeCliSource = getClaudeCodeCliSource();
    const defaultWorkerBackendId = getSettings().defaultWorkerBackendId ?? null;
    const effectiveDefaultWorkerBackendId = resolveDefaultWorkerBackendId(defaultBackend);
    const bundledClaudePath = resolveClaudeBundledBinary();
    const systemClaudePath = resolveClaudeCliBinary();
    const bundledClaudeVersion = probeWorkerRuntimeVersion('claude-code', bundledClaudePath);
    const systemClaudeVersion = probeWorkerRuntimeVersion('claude-code', systemClaudePath);

    const result = await Promise.all(registry.listWithStatus().map(async ({ backend, available, binaryPath }) => {
      const auth = authEntries.find((e) => e.backendId === backend.id);
      let loggedIn = false;
      if (available && backend.checkAuthStatus) {
        try { loggedIn = (await backend.checkAuthStatus()).loggedIn; } catch { loggedIn = false; }
      }
      const version = probeWorkerRuntimeVersion(backend.id, binaryPath);
      const runtime = assessConfiguredWorkerRuntime({
        backendId: backend.id,
        installed: available,
        implementationEnabled: backend.capabilities.executeTasks,
        authenticated: loggedIn || Boolean(auth?.apiKey) || (
          backend.id === 'opencode' && (auth?.authMode ?? 'none') === 'none'
        ),
        version,
        ...(backend.id === 'claude-code' ? { claudeCodeCliSource } : {}),
      });
      return {
        id: backend.id,
        displayName: backend.capabilities.displayName,
        iconId: backend.capabilities.iconId,
        available,
        binaryPath,
        authMode: auth?.authMode ?? 'none',
        hasApiKey: Boolean(auth?.apiKey),
        hasAuthEntry: Boolean(auth),
        loggedIn,
        baseUrl: auth?.baseUrl ?? null,
        model: auth?.model ?? null,
        defaultModel: backend.capabilities.defaultModel ?? null,
        models: backend.capabilities.models ?? null,
        isDefault: backend.id === defaultBackend,
        installHint: backend.capabilities.installHint ?? null,
        supportsMcp: backend.capabilities.mcp,
        supportsPermissions: backend.capabilities.permissions,
        supportsCoordinator: backend.capabilities.coordinate,
        supportsWorkers: runtime.state === 'available',
        workerImplementation: backend.capabilities.executeTasks,
        workerRuntimeState: runtime.state,
        workerRuntimeReason: runtime.reason,
        version: runtime.version,
        expectedVersion: runtime.expectedVersion,
        claudeCodeCliSource: backend.id === 'claude-code' ? claudeCodeCliSource : null,
        defaultWorkerBackendId: backend.id === 'claude-code' ? defaultWorkerBackendId : null,
        effectiveDefaultWorkerBackendId: backend.id === 'claude-code'
          ? effectiveDefaultWorkerBackendId
          : null,
        bundledClaudeVersion: backend.id === 'claude-code' ? bundledClaudeVersion : null,
        systemClaudeVersion: backend.id === 'claude-code' ? systemClaudeVersion : null,
        bundledClaudeAvailable: backend.id === 'claude-code' ? bundledClaudePath !== null : null,
        systemClaudeAvailable: backend.id === 'claude-code' ? systemClaudePath !== null : null,
        customAvatar: auth?.customAvatar ?? null,
        workerReleaseTier: backend.capabilities.executeTasks
          ? (FIRST_RELEASE_STABLE_WORKERS.has(backend.id) ? 'stable' : 'experimental')
          : 'blocked',
      };
    }));

    return result;
  });

  /** Get auth config for a specific backend. */
  ipcMain.handle('backend-auth:get-config', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const auth = getBackendAuth(backendId);
    return {
      ok: true,
      config: auth
        ? {
            authMode: auth.authMode,
            hasApiKey: Boolean(auth.apiKey),
            baseUrl: auth.baseUrl ?? null,
            model: auth.model ?? null,
            lastValidatedAt: auth.lastValidatedAt ?? null,
          }
        : null,
    };
  });

  /** Set API key for a specific backend. */
  ipcMain.handle('backend-auth:set-api-key', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, key } = payload as { backendId?: string; key?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const validationError = validateBackendId(backendId);
    if (validationError) {
      return { ok: false, error: validationError };
    }
    if (typeof key !== 'string') {
      return { ok: false, error: 'key must be a string' };
    }
    const trimmed = key.trim();
    const patch: Partial<BackendAuthEntry> = trimmed.length === 0
      ? { authMode: 'none', apiKey: undefined, apiKeyEnc: undefined }
      : { authMode: 'apikey', apiKey: trimmed };
    try {
      await setBackendAuth(backendId, patch);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set base URL for a specific backend. */
  ipcMain.handle('backend-auth:set-base-url', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, url } = payload as { backendId?: string; url?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    if (typeof url !== 'string') {
      return { ok: false, error: 'url must be a string' };
    }
    const trimmed = url.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:') {
          // Allow http:// only for localhost (local development)
          const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
          if (parsed.protocol !== 'http:' || !isLocalhost) {
            return { ok: false, error: 'base URL must use https:// (http:// allowed only for localhost)' };
          }
        }
      } catch {
        return { ok: false, error: 'invalid URL format' };
      }
    }
    try {
      await setBackendAuth(backendId, { baseUrl: trimmed.length === 0 ? undefined : trimmed });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set model for a specific backend. */
  ipcMain.handle('backend-auth:set-model', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, model } = payload as { backendId?: string; model?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    if (typeof model !== 'string') {
      return { ok: false, error: 'model must be a string' };
    }
    const trimmed = model.trim();
    try {
      await setBackendAuth(backendId, { model: trimmed.length === 0 ? undefined : trimmed });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set auth mode for a specific backend. */
  ipcMain.handle('backend-auth:set-mode', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, mode } = payload as { backendId?: string; mode?: string };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    if (mode !== 'apikey' && mode !== 'oauth' && mode !== 'none') {
      return { ok: false, error: 'mode must be apikey, oauth, or none' };
    }
    try {
      await setBackendAuth(backendId, { authMode: mode });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set custom avatar for a specific backend (base64 data URL, or null to remove). */
  ipcMain.handle('backend-auth:set-avatar', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { backendId, dataUrl } = payload as { backendId?: string; dataUrl?: string | null };
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    if (dataUrl !== null && typeof dataUrl !== 'string') {
      return { ok: false, error: 'dataUrl must be a string or null' };
    }
    if (typeof dataUrl === 'string') {
      if (!/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(dataUrl)) {
        return { ok: false, error: 'avatar must be a base64 PNG, JPEG, or WebP image' };
      }
      if (dataUrl.length > 2 * 1024 * 1024) {
        return { ok: false, error: 'avatar must be smaller than 2 MB' };
      }
    }
    try {
      await setBackendAuth(backendId, { customAvatar: dataUrl ?? undefined });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Choose bundled vs system Claude Code CLI for worker execution. */
  ipcMain.handle('backend-auth:set-claude-cli-source', async (_e, source: unknown) => {
    if (source !== 'bundled' && source !== 'system') {
      return { ok: false, error: 'source must be "bundled" or "system"' };
    }
    if (source === 'bundled' && !resolveClaudeBundledBinary()) {
      return { ok: false, error: 'bundled Claude Code CLI is not available on this platform' };
    }
    if (source === 'system' && !resolveClaudeCliBinary()) {
      return { ok: false, error: 'no Claude Code CLI found on PATH' };
    }
    try {
      await updateSettings({ claudeCodeCliSource: source as ClaudeCodeCliSource });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Default executor backend for worker tasks (claude-code vs claude-code-terminal). */
  ipcMain.handle('backend-auth:set-default-worker-backend', async (_e, backendId: unknown) => {
    if (backendId !== 'claude-code' && backendId !== 'claude-code-terminal') {
      return { ok: false, error: 'backendId must be "claude-code" or "claude-code-terminal"' };
    }
    const backend = getBackendRegistry().get(backendId);
    if (!backend?.capabilities.executeTasks) {
      return { ok: false, error: `backend '${backendId}' cannot execute worker tasks` };
    }
    try {
      await updateSettings({ defaultWorkerBackendId: backendId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Set the default backend for new sessions. */
  ipcMain.handle('backend-auth:set-default', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };
    const backend = getBackendRegistry().get(backendId);
    if (!backend?.capabilities.coordinate) {
      return { ok: false, error: `backend '${backendId}' cannot coordinate` };
    }
    try {
      await setDefaultBackend(backendId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  /** Check auth status for a specific backend. */
  ipcMain.handle('backend-auth:check-status', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const registry = getBackendRegistry();
    const backend = registry.get(backendId);
    if (!backend) {
      return { ok: false, error: `unknown backend: ${backendId}` };
    }
    if (backend.checkAuthStatus) {
      const status = await backend.checkAuthStatus();
      return { ok: true, ...status };
    }
    // For backends without explicit auth check, having an API key or the
    // binary available counts as "logged in".
    const auth = getBackendAuth(backendId);
    const available = registry.isAvailable(backendId);
    return {
      ok: true,
      loggedIn: Boolean(auth?.apiKey) || available,
    };
  });

  /** Run OAuth login flow for a backend. Spawns the CLI's login command
   *  (e.g. `claude auth login`, `kimi /login`, `codex auth login`).
   *  The CLI typically opens a browser for the user to authenticate. */
  ipcMain.handle('backend-auth:login-oauth', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };

    const registry = getBackendRegistry();
    const backend = registry.get(backendId);
    if (!backend) {
      return { ok: false, error: `unknown backend: ${backendId}` };
    }

    // Claude Code uses a special auth:login-subscription handler because
    // it needs to resolve the bundled claude binary from the SDK package.
    if (backendId === 'claude-code') {
      // Delegate to the existing auth:login-subscription handler
      return { ok: false, error: 'Use auth:login-subscription for Claude Code' };
    }

    if (!backend.loginOAuth) {
      return { ok: false, error: `${backend.capabilities.displayName} does not support OAuth login` };
    }

    const result = await backend.loginOAuth();
    if (result.ok) {
      // Update auth mode to oauth on success
      await setBackendAuth(backendId, { authMode: 'oauth', apiKey: undefined });
    }
    return result;
  });

  /** Run the install command for a backend that isn't available yet.
   *
   *  Streams `backend:install-progress` events to the renderer while the
   *  subprocess runs. Final result is returned via the invoke reply. Only
   *  one install may be active at a time — a second concurrent call for
   *  the same backend returns "in progress"; a different backend is
   *  rejected until the first finishes. */
  ipcMain.handle('backend-auth:install', async (_e, backendId: unknown) => {
    if (typeof backendId !== 'string') {
      return { ok: false, error: 'backendId must be a string' };
    }
    const vErr = validateBackendId(backendId);
    if (vErr) return { ok: false, error: vErr };

    // Guard against concurrent installs.
    if (activeInstall) {
      if (activeInstall.backendId === backendId) {
        return { ok: false, error: 'Install already in progress' };
      }
      return { ok: false, error: `Another install is in progress (${activeInstall.backendId})` };
    }

    const registry = getBackendRegistry();
    const backend = registry.get(backendId);
    if (!backend) {
      return { ok: false, error: `unknown backend: ${backendId}` };
    }

    // Decide what to spawn based on whether the backend has an npm package
    // (structured install) or only a shell hint (e.g. curl | bash for Kimi).
    const npmPackage = backend.capabilities.npmPackage;
    const hint = backend.capabilities.installHint ?? '';

    let cmd: string;
    let args: string[];
    if (npmPackage) {
      cmd = resolveNpmBinary();
      args = ['install', '-g', npmPackage];
    } else if (hint && hint !== 'Bundled with AhaStation') {
      // Use platform-appropriate shell
      if (process.platform === 'win32') {
        cmd = process.env.ComSpec ?? 'cmd.exe';
        args = ['/c', hint];
      } else {
        cmd = '/bin/sh';
        args = ['-c', hint];
      }
    } else {
      return { ok: false, error: 'No install command available for this backend' };
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      try {
        const child = spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          // Augmented PATH so npm can find node and the freshly-installed
          // binary lands in a location resolveBinaryFromPath() can discover.
          env: installEnv(),
        });
        activeInstall = { backendId, proc: child };

        const sendProgress = (data: string) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('backend:install-progress', { backendId, data });
          }
        };

        // Show the user what we're running — without this the log is empty
        // until npm starts printing, which can take several seconds.
        sendProgress(`$ ${cmd} ${args.join(' ')}\n\n`);

        child.stdout?.on('data', (buf: Buffer) => sendProgress(buf.toString()));
        child.stderr?.on('data', (buf: Buffer) => sendProgress(buf.toString()));

        child.on('close', (code) => {
          activeInstall = null;
          if (code === 0) {
            const installedBinary = backend.resolveBinary();
            if (installedBinary) {
              sendProgress(`\n✓ Runtime ready: ${installedBinary}\n`);
              resolve({ ok: true });
            } else {
              resolve({
                ok: false,
                error: '安装程序已结束，但应用仍找不到 CLI。请重启应用后重试。',
              });
            }
          } else {
            resolve({ ok: false, error: `Install exited with code ${code}` });
          }
        });

        child.on('error', (err) => {
          activeInstall = null;
          sendProgress(`\n✗ Failed to start install: ${err.message}\n`);
          resolve({ ok: false, error: err.message });
        });
      } catch (err) {
        activeInstall = null;
        resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  // ── Custom backend CRUD ─────────────────────────────────────────────────────

  /** List all custom backend entries. */
  ipcMain.handle('custom-backend:list', async () => {
    return listCustomBackends();
  });

  /** Add a new custom backend. */
  ipcMain.handle('custom-backend:add', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { id, displayName, binaryName, apiKeyEnv, baseUrlEnv, defaultModel, installHint, npmPackage } =
      payload as {
        id?: string;
        displayName?: string;
        binaryName?: string;
        apiKeyEnv?: string;
        baseUrlEnv?: string;
        defaultModel?: string;
        installHint?: string;
        npmPackage?: string;
      };

    if (typeof id !== 'string' || id.trim().length === 0) {
      return { ok: false, error: 'ID is required' };
    }
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      return { ok: false, error: 'Display name is required' };
    }
    if (typeof binaryName !== 'string' || binaryName.trim().length === 0) {
      return { ok: false, error: 'Binary name is required' };
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(binaryName.trim())) {
      return { ok: false, error: 'Binary name contains invalid characters (only alphanumeric, dots, hyphens, underscores allowed)' };
    }

    // Prefix custom backends with "custom-" to avoid collisions with built-in IDs
    const finalId = id.startsWith('custom-') ? id : `custom-${id}`;

    const result = await addCustomBackend({
      id: finalId,
      displayName: displayName.trim(),
      binaryName: binaryName.trim(),
      apiKeyEnv: apiKeyEnv?.trim() || undefined,
      baseUrlEnv: baseUrlEnv?.trim() || undefined,
      defaultModel: defaultModel?.trim() || undefined,
      installHint: installHint?.trim() || undefined,
      npmPackage: npmPackage?.trim() || undefined,
    });

    if (result.ok) {
      // Re-register all custom backends so the new one is immediately available
      registerCustomBackends();
    }

    return result;
  });

  /** Update a custom backend. */
  ipcMain.handle('custom-backend:update', async (_e, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: 'payload must be an object' };
    }
    const { id, ...patch } = payload as { id?: string; [key: string]: unknown };

    if (typeof id !== 'string') {
      return { ok: false, error: 'ID is required' };
    }

    // Validate binaryName if present — must be safe for PATH resolution
    if (typeof patch.binaryName === 'string' && patch.binaryName.length > 0) {
      if (!/^[a-zA-Z0-9._-]+$/.test(patch.binaryName)) {
        return { ok: false, error: 'binaryName contains invalid characters (only alphanumeric, dots, hyphens, underscores allowed)' };
      }
    }

    const result = await updateCustomBackend(id, patch as {
      displayName?: string;
      binaryName?: string;
      apiKeyEnv?: string;
      baseUrlEnv?: string;
      defaultModel?: string;
      installHint?: string;
      npmPackage?: string;
    });

    if (result.ok) {
      // Re-register all custom backends to pick up changes
      registerCustomBackends();
    }

    return result;
  });

  /** Remove a custom backend. */
  ipcMain.handle('custom-backend:remove', async (_e, id: unknown) => {
    if (typeof id !== 'string') {
      return { ok: false, error: 'ID must be a string' };
    }

    const registry = getBackendRegistry();
    const result = await removeCustomBackend(id);

    if (result.ok) {
      // Unregister the backend from the registry
      registry.unregister(id);
      // Also remove any auth entry for this backend
      await removeBackendAuth(id);
    }

    return result;
  });
}
