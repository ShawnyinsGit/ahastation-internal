// editor-scene.ts — editor "scene" state for overlay ↔ window migration
// (Phase 6a, §3.2 dual-display). When the editor form factor switches, the
// dying form reports its scene (hostId, selected file, scroll position) and
// the new form restores it. Pure + electron-free: serialization and the
// in-memory store are unit-testable; the IPC layer writes/reads through the
// singleton at the bottom.

export interface EditorSceneState {
  hostId: string;
  /** Workspace-relative file path currently open in the code viewer. */
  selectedFile: string | null;
  /** Code viewer scroll position (px). */
  scrollTop: number;
  /** Last update time (ms) — freshest report wins. */
  updatedAt: number;
}

export function serializeEditorScene(scene: EditorSceneState): string {
  return JSON.stringify(scene);
}

/** Parse + validate a serialized scene. Returns null on any shape drift —
 *  a stale/foreign payload must never crash the restore path. */
export function parseEditorScene(raw: unknown): EditorSceneState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.hostId !== 'string' || obj.hostId.length === 0) return null;
  if (obj.selectedFile !== null && obj.selectedFile !== undefined && typeof obj.selectedFile !== 'string') {
    return null;
  }
  return {
    hostId: obj.hostId,
    selectedFile: (obj.selectedFile as string | null) ?? null,
    scrollTop: typeof obj.scrollTop === 'number' && obj.scrollTop >= 0 ? obj.scrollTop : 0,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : 0,
  };
}

/** Last-write-wins scene store keyed by hostId. */
export class EditorSceneStore {
  private readonly scenes = new Map<string, EditorSceneState>();

  report(scene: EditorSceneState): void {
    const existing = this.scenes.get(scene.hostId);
    if (existing && existing.updatedAt > scene.updatedAt) return;
    this.scenes.set(scene.hostId, scene);
  }

  get(hostId: string): EditorSceneState | null {
    const scene = this.scenes.get(hostId);
    return scene ? { ...scene } : null;
  }

  clear(hostId: string): boolean {
    return this.scenes.delete(hostId);
  }

  get size(): number {
    return this.scenes.size;
  }
}

let singleton: EditorSceneStore | null = null;

export function getEditorSceneStore(): EditorSceneStore {
  if (!singleton) singleton = new EditorSceneStore();
  return singleton;
}
