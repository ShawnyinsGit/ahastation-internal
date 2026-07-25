// registry.ts — singleton registry of all CLI backend adapters.
//
// Populated at app startup with all known backends. Provides lookup by ID,
// listing, and availability checking. The orchestrator and settings UI
// query this registry to discover and create backend sessions.

import type { CliBackend, BackendAuthConfig } from './cli-backend.js';
import { ClaudeCodeBackend } from './claude-code-adapter.js';
import { ClaudeTerminalBackend } from './claude-terminal-adapter.js';
import { CodexBackend } from './codex-adapter.js';
import { KimiBackend } from './kimi-adapter.js';
import { QoderBackend } from './qoder-adapter.js';
import { CustomBackend, type CustomBackendOptions } from './custom-adapter.js';
import { OpenCodeBackend } from './opencode-adapter.js';
import { PocketVibeBackend } from './pocket-vibe-adapter.js';
import type { ConfirmDestructive } from '../claude-session.js';
import type {
  BackendEffectiveProfile,
  TaskExecutionProfile,
} from '../task-collaboration.js';
import type { BackendRuntime } from './task-profile.js';
import {
  assessWorkerRelease,
  type WorkerReleaseAssessment,
  type WorkerStabilityEvidence,
} from './worker-runtime-contract.js';

export interface BackendStatus {
  backend: CliBackend;
  available: boolean;
  binaryPath: string | null;
}

export interface BackendProbe {
  backendId: string;
  installed: boolean;
  runtimePath: string | null;
  auth: 'ready' | 'configured' | 'required';
  capabilities: { coordinate: boolean; executeTasks: boolean };
  blockers: Array<'runtime-unavailable' | 'authentication-required'>;
}

export class BackendRegistry {
  private backends = new Map<string, CliBackend>();

  register(backend: CliBackend): void {
    this.backends.set(backend.id, backend);
  }

  /** Remove a backend by ID. Used when a custom backend is deleted. */
  unregister(id: string): void {
    this.backends.delete(id);
  }

  get(id: string): CliBackend | undefined {
    return this.backends.get(id);
  }

  compileTaskProfile(
    id: string,
    requested: TaskExecutionProfile,
    runtime: BackendRuntime,
  ): BackendEffectiveProfile {
    const backend = this.backends.get(id);
    if (!backend) throw new Error(`backend '${id}' is not registered`);
    if (!backend.capabilities.executeTasks) {
      throw new Error(`backend '${id}' cannot execute delivery tasks`);
    }
    if (!backend.compileTaskProfile) {
      throw new Error(`backend '${id}' does not compile task profiles`);
    }
    return backend.compileTaskProfile(requested, runtime);
  }

  assessWorkerRelease(
    id: string,
    expectedRuntimeVersion: string | null,
    evidence: WorkerStabilityEvidence,
  ): WorkerReleaseAssessment {
    const backend = this.backends.get(id);
    if (!backend) throw new Error(`backend '${id}' is not registered`);
    return assessWorkerRelease({
      backendId: id,
      implementationEnabled: backend.capabilities.executeTasks,
      expectedRuntimeVersion,
      evidence,
    });
  }

  list(): CliBackend[] {
    return Array.from(this.backends.values());
  }

  /** Return backends with their availability status. */
  listWithStatus(): BackendStatus[] {
    return this.list().map((backend) => {
      const binaryPath = backend.resolveBinary();
      return {
        backend,
        available: binaryPath !== null,
        binaryPath,
      };
    });
  }

  /** Only backends whose binary resolves successfully. */
  available(): CliBackend[] {
    return this.list().filter((b) => b.resolveBinary() !== null);
  }

  /** Check if a specific backend is available. */
  isAvailable(id: string): boolean {
    const backend = this.backends.get(id);
    return backend !== undefined && backend.resolveBinary() !== null;
  }

  async probe(id: string, auth: BackendAuthConfig): Promise<BackendProbe> {
    const backend = this.backends.get(id);
    if (!backend) throw new Error(`backend '${id}' is not registered`);
    const runtimePath = backend.resolveBinary();
    const installed = runtimePath !== null;
    let authState: BackendProbe['auth'] = 'required';
    if (auth.authMode === 'apikey' && auth.apiKey) {
      const validation = await backend.validateAuth?.(auth);
      if (validation?.ok !== false) authState = 'configured';
    } else if (installed && backend.checkAuthStatus) {
      try {
        if ((await backend.checkAuthStatus()).loggedIn) authState = 'ready';
      } catch { /* remain required */ }
    } else if (auth.authMode === 'none' && !backend.checkAuthStatus) {
      authState = 'ready';
    }
    const blockers: BackendProbe['blockers'] = [];
    if (!installed) blockers.push('runtime-unavailable');
    if (authState === 'required') blockers.push('authentication-required');
    return {
      backendId: id,
      installed,
      runtimePath,
      auth: authState,
      capabilities: {
        coordinate: backend.capabilities.coordinate,
        executeTasks: backend.capabilities.executeTasks,
      },
      blockers,
    };
  }

  /** Register a custom backend from user-provided options. */
  registerCustom(options: CustomBackendOptions): void {
    this.register(new CustomBackend(options));
  }
}

// ── Singleton instance ─────────────────────────────────────────────────────────

let instance: BackendRegistry | null = null;

export function getBackendRegistry(confirmDestructive?: ConfirmDestructive): BackendRegistry {
  if (!instance) {
    instance = new BackendRegistry();
    // Register all known backends. Order determines default selection.
    instance.register(new ClaudeCodeBackend({ confirmDestructive }));
    instance.register(new ClaudeTerminalBackend());
    instance.register(new CodexBackend());
    instance.register(new KimiBackend());
    instance.register(new QoderBackend());
    instance.register(new OpenCodeBackend());
    instance.register(new PocketVibeBackend());
  }
  return instance;
}

/** Register custom backends from settings. Called after settings are loaded. */
export function registerCustomBackends(): void {
  const registry = getBackendRegistry();
  // Lazy import to avoid circular dependency at module load time.
  // settings-loader will call this after settings are available.
  let listCustomBackends: () => import('../store.js').CustomBackendEntry[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const store = require('../store.js');
    listCustomBackends = store.listCustomBackends;
  } catch {
    // Settings module not yet available — custom backends will be registered later
    return;
  }

  try {
    const customBackends = listCustomBackends();
    for (const entry of customBackends) {
      registry.registerCustom({
        id: entry.id,
        displayName: entry.displayName,
        binaryName: entry.binaryName,
        apiKeyEnv: entry.apiKeyEnv,
        baseUrlEnv: entry.baseUrlEnv,
        defaultModel: entry.defaultModel,
        installHint: entry.installHint,
        npmPackage: entry.npmPackage,
      });
    }
  } catch (err) {
    console.error('[registry] failed to register custom backends:', err);
  }
}

/** Reset the singleton (for testing). */
export function resetBackendRegistry(): void {
  instance = null;
}
