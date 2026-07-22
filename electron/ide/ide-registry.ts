// ide-registry.ts — IDE catalog + persisted default/override state (Phase 3).
//
// Answers "which IDE backs the editor window for this hostId":
//   perHostOverride[hostId] ?? defaultIdeId   (override key is hostId — v1.2)
// backed by a userData JSON file (ide-registry.json). Detection of the
// actually-installed IDEs is injectable; the OpenCode check resolves the
// bundled binary and runs --version. Hermes/Pi are catalog stubs
// (comingSoon) that prove a second IDE only needs the EditorIdeAdapter
// interface.

import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveOpencodeBinary } from '../backends/opencode-server-process.js';
import type { EditorIdeAdapter } from './ide-adapter.js';
import { OpenCodeEditorAdapter, StubEditorAdapter } from './opencode/opencode-editor-adapter.js';

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────────────

export interface IdeInfo {
  id: string;
  displayName: string;
  description: string;
  installed: boolean;
  version: string | null;
  /** Catalog entry without a usable server API yet — Settings shows 即将支持. */
  comingSoon: boolean;
}

export interface IdeRegistryPersisted {
  defaultIdeId: string;
  perHostOverride: Record<string, string>;
}

export interface IdeRegistryState extends IdeRegistryPersisted {
  ides: IdeInfo[];
}

export interface IdeDetection {
  id: string;
  installed: boolean;
  version: string | null;
}

export interface IdeRegistryDeps {
  load: () => Partial<IdeRegistryPersisted>;
  save: (state: IdeRegistryPersisted) => void;
  detect: () => Promise<IdeDetection[]>;
}

/** IDE resolution order: per-host override wins, then the persisted default. */
export function resolveIdeForHost(
  state: Pick<IdeRegistryPersisted, 'defaultIdeId' | 'perHostOverride'>,
  hostId: string,
): string {
  return state.perHostOverride[hostId] ?? state.defaultIdeId;
}

const CATALOG: Array<Omit<IdeInfo, 'installed' | 'version'>> = [
  {
    id: 'opencode',
    displayName: 'OpenCode',
    description: '开源 AI coding agent（内置打包，server 模式接入）',
    comingSoon: false,
  },
  {
    id: 'hermes',
    displayName: 'Hermes Agent',
    description: 'Nous Research 开源 CLI agent，自我改进技能',
    comingSoon: true,
  },
  {
    id: 'pi',
    displayName: 'Pi Agent',
    description: '极简 agent harness，轻量可扩展',
    comingSoon: true,
  },
];

const FALLBACK_DEFAULT_ID = 'opencode';

// ── Registry ────────────────────────────────────────────────────────────────

export class IdeRegistry {
  private readonly adapters = new Map<string, EditorIdeAdapter>();
  private ides: IdeInfo[] = [];
  private persisted: IdeRegistryPersisted = {
    defaultIdeId: FALLBACK_DEFAULT_ID,
    perHostOverride: {},
  };
  private initPromise: Promise<void> | null = null;

  constructor(private readonly deps: IdeRegistryDeps) {
    this.adapters.set('opencode', new OpenCodeEditorAdapter());
    this.adapters.set('hermes', new StubEditorAdapter('hermes', 'Hermes Agent'));
    this.adapters.set('pi', new StubEditorAdapter('pi', 'Pi Agent'));
  }

  /** Idempotent, promise-cached initialization (detection + persisted load). */
  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const stored = this.deps.load();
    if (typeof stored.defaultIdeId === 'string' && stored.defaultIdeId) {
      this.persisted.defaultIdeId = stored.defaultIdeId;
    }
    if (stored.perHostOverride && typeof stored.perHostOverride === 'object') {
      this.persisted.perHostOverride = { ...stored.perHostOverride };
    }

    let detections: IdeDetection[] = [];
    try {
      detections = await this.deps.detect();
    } catch (err) {
      console.warn('[ide-registry] detection failed:', err);
    }
    this.ides = CATALOG.map((meta) => {
      const det = detections.find((d) => d.id === meta.id);
      return { ...meta, installed: det?.installed ?? false, version: det?.version ?? null };
    });

    // Sanitize persisted state against reality: a default (or override) that
    // points at an uninstalled IDE silently breaks "open editor".
    if (!this.isInstalled(this.persisted.defaultIdeId)) {
      this.persisted.defaultIdeId = FALLBACK_DEFAULT_ID;
    }
    for (const [hostId, ideId] of Object.entries(this.persisted.perHostOverride)) {
      if (!this.isInstalled(ideId)) {
        delete this.persisted.perHostOverride[hostId];
      }
    }
    this.persist();
  }

  private isInstalled(id: string): boolean {
    return this.ides.some((i) => i.id === id && i.installed);
  }

  private persist(): void {
    try {
      this.deps.save({ ...this.persisted, perHostOverride: { ...this.persisted.perHostOverride } });
    } catch (err) {
      console.warn('[ide-registry] persist failed:', err);
    }
  }

  getState(): IdeRegistryState {
    return {
      ides: this.ides.map((i) => ({
        ...i,
        capabilities: this.adapters.get(i.id)?.capabilities,
      })),
      defaultIdeId: this.persisted.defaultIdeId,
      perHostOverride: { ...this.persisted.perHostOverride },
    };
  }

  setDefault(id: string): { ok: boolean; error?: string } {
    if (!this.isInstalled(id)) {
      return { ok: false, error: `IDE '${id}' is not installed` };
    }
    this.persisted.defaultIdeId = id;
    this.persist();
    return { ok: true };
  }

  /** Set (or clear, with null) the per-host override. Key is hostId — v1.2. */
  setOverride(hostId: string, ideId: string | null): { ok: boolean; error?: string } {
    if (ideId === null) {
      delete this.persisted.perHostOverride[hostId];
    } else {
      if (!this.isInstalled(ideId)) {
        return { ok: false, error: `IDE '${ideId}' is not installed` };
      }
      this.persisted.perHostOverride[hostId] = ideId;
    }
    this.persist();
    return { ok: true };
  }

  /** The adapter that should back this host's editor window, or null when
   *  the resolved IDE is not installed. */
  resolveAdapterForHost(hostId: string): EditorIdeAdapter | null {
    const ideId = resolveIdeForHost(this.persisted, hostId);
    if (!this.isInstalled(ideId)) return null;
    return this.adapters.get(ideId) ?? null;
  }
}

// ── Singleton with real deps ────────────────────────────────────────────────

let singleton: IdeRegistry | null = null;

function registryPath(): string {
  return join(app.getPath('userData'), 'ide-registry.json');
}

async function detectIdes(): Promise<IdeDetection[]> {
  const results: IdeDetection[] = [];
  const binary = resolveOpencodeBinary();
  let version: string | null = null;
  if (binary) {
    try {
      const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 10_000 });
      version = stdout.trim() || null;
    } catch (err) {
      console.warn('[ide-registry] opencode --version failed:', err);
    }
  }
  results.push({ id: 'opencode', installed: binary !== null, version });
  results.push({ id: 'hermes', installed: false, version: null });
  results.push({ id: 'pi', installed: false, version: null });
  return results;
}

export function getIdeRegistry(): IdeRegistry {
  if (!singleton) {
    singleton = new IdeRegistry({
      load: () => {
        try {
          return JSON.parse(readFileSync(registryPath(), 'utf8')) as Partial<IdeRegistryPersisted>;
        } catch {
          return {};
        }
      },
      save: (state) => {
        const path = registryPath();
        const dir = join(path, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
        renameSync(tmp, path);
      },
      detect: detectIdes,
    });
  }
  return singleton;
}
