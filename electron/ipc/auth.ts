import { ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import { getSettings, updateSettings } from '../store.js';
import { mergedSubprocessEnv } from '../settings-loader.js';
import { resolveClaudeBinaryForSource, spawnTargetFor } from '../claude-cli/resolve.js';

/** Resolve the claude CLI the same way sessions do: the user's
 *  claudeCodeCliSource setting picks system PATH vs the bundled binary. */
function resolveClaudeBin(): string | null {
  return resolveClaudeBinaryForSource();
}

export function registerAuthIpc(): void {
  ipcMain.handle('auth:get-config', async () => {
    const s = getSettings();
    return {
      authMode: s.authMode ?? null,
      // Never send the actual key back to the renderer — only indicate if one is set.
      hasApiKey: Boolean(s.anthropicApiKey),
      // Base URL + model are non-secret config; safe to round-trip for prefill.
      baseUrl: s.anthropicBaseUrl ?? null,
      model: s.anthropicModel ?? null,
    };
  });

  ipcMain.handle('auth:set-api-key', async (_e, key: unknown) => {
    if (typeof key !== 'string') {
      return { ok: false, error: 'key must be a string' };
    }
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      await updateSettings({ anthropicApiKey: undefined, authMode: undefined });
      return { ok: true };
    }
    await updateSettings({ anthropicApiKey: trimmed, authMode: 'apikey' });
    return { ok: true };
  });

  ipcMain.handle('auth:set-base-url', async (_e, url: unknown) => {
    if (typeof url !== 'string') {
      return { ok: false, error: 'url must be a string' };
    }
    const trimmed = url.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:') {
          return { ok: false, error: 'base URL must use https://' };
        }
      } catch {
        return { ok: false, error: 'invalid URL format' };
      }
    }
    await updateSettings({ anthropicBaseUrl: trimmed.length === 0 ? undefined : trimmed });
    return { ok: true };
  });

  ipcMain.handle('auth:set-model', async (_e, model: unknown) => {
    if (typeof model !== 'string') {
      return { ok: false, error: 'model must be a string' };
    }
    const trimmed = model.trim();
    await updateSettings({ anthropicModel: trimmed.length === 0 ? undefined : trimmed });
    return { ok: true };
  });

  ipcMain.handle('auth:set-mode', async (_e, mode: unknown) => {
    if (mode !== 'apikey' && mode !== 'subscription' && mode !== null) {
      return { ok: false, error: 'mode must be apikey, subscription, or null' };
    }
    await updateSettings({ authMode: (mode as 'apikey' | 'subscription') ?? undefined });
    return { ok: true };
  });

  /** Run `claude auth login` in a child process.
   *  The claude CLI opens a browser for OAuth; we wait for it to exit. */
  ipcMain.handle('auth:login-subscription', async () => {
    const claudeBin = resolveClaudeBin();
    if (!claudeBin) {
      return { ok: false, error: 'claude binary not found' };
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const env = mergedSubprocessEnv();
      const target = spawnTargetFor(claudeBin, ['auth', 'login']);
      const proc = spawn(target.file, target.args, {
        env,
        stdio: 'ignore',
        detached: false,
      });
      proc.on('error', (err: Error) => {
        resolve({ ok: false, error: err.message });
      });
      proc.on('close', (code: number | null) => {
        if (code === 0) {
          updateSettings({ authMode: 'subscription', anthropicApiKey: undefined })
            .catch((err) => console.error('[auth] failed to persist authMode:', err))
            .finally(() => resolve({ ok: true }));
        } else {
          resolve({ ok: false, error: `claude auth login exited with code ${code}` });
        }
      });
    });
  });

  /** Check subscription login status by asking the Claude CLI directly.
   *  The CLI stores OAuth credentials in its own internal storage (Keychain on
   *  macOS), not a plain JSON file, so we run `claude auth status --json`
   *  rather than checking for a credentials file on disk. */
  ipcMain.handle('auth:check-subscription-status', async () => {
    const claudeBin = resolveClaudeBin();
    if (!claudeBin) {
      return { loggedIn: false };
    }

    return new Promise<{ loggedIn: boolean }>((resolve) => {
      const env = mergedSubprocessEnv();
      let stdout = '';
      let stderr = '';
      const target = spawnTargetFor(claudeBin, ['auth', 'status', '--json']);
      const proc = spawn(target.file, target.args, {
        env,
        stdio: 'pipe',
        detached: false,
      });
      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });
      proc.on('error', () => {
        resolve({ loggedIn: false });
      });
      proc.on('close', (code: number | null) => {
        if (code !== 0) {
          resolve({ loggedIn: false });
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ loggedIn: Boolean(parsed?.loggedIn) });
        } catch {
          resolve({ loggedIn: false });
        }
      });
    });
  });
}
