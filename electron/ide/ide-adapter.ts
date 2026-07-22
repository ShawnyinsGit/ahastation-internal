// ide-adapter.ts — EditorIdeAdapter interface (Phase 3).
//
// One interface per IDE that can back an independent editor window. The
// OpenCode implementation wraps the spawned opencode server + event
// pipeline; a second IDE only needs to implement this interface (the
// Hermes/Pi stubs below prove the shape). The adapter never exposes the
// server URL or credentials — those stay in main (§2.1/§2.2 rule 4);
// the renderer sees only the window and its narrow preload API.

export interface EditorIdeCapabilities {
  /** Live event stream (activity timeline, status light). */
  events: boolean;
  /** Embedded terminal (PTY). Phase 4 delivers PtyPanel. */
  pty: boolean;
  /** File writes through the IDE. Always false — writes stay on the main
   *  process fs path (v1.2). */
  fileWrite: false;
  /** Session diff panel. */
  diff: boolean;
  /** Todo panel. */
  todo: boolean;
  /** Permission bridge. */
  permissions: boolean;
}

export interface EditorIdeAttachOptions {
  hostId: string;
  backendId: string;
  /** Meeting tab id the editor window belongs to. */
  sessionId: string;
  cwd: string;
  title?: string;
}

export interface IdeEditorHandle {
  capabilities: EditorIdeCapabilities;
  close(): void;
}

export interface EditorIdeAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: EditorIdeCapabilities;
  /** Open (or focus) the editor window for this host and return a handle.
   *  Implementations keep every server credential in main. */
  attach(opts: EditorIdeAttachOptions): Promise<IdeEditorHandle>;
}

export const NO_EDITOR_CAPABILITIES: EditorIdeCapabilities = {
  events: false,
  pty: false,
  fileWrite: false,
  diff: false,
  todo: false,
  permissions: false,
};

const CAPABILITY_KEYS = ['events', 'pty', 'diff', 'todo', 'permissions'] as const;

/** Serialize UI-relevant capabilities into the editor window URL query
 *  (fileWrite is always false and omitted). */
export function serializeEditorCapabilities(caps: EditorIdeCapabilities): string {
  return CAPABILITY_KEYS.filter((k) => caps[k]).join(',');
}

/** Mirror of the renderer-side parse (kept here so both ends are tested
 *  against the same spec). */
export function parseEditorCapabilities(raw: string | null | undefined): EditorIdeCapabilities {
  const set = new Set((raw ?? '').split(',').filter(Boolean));
  return {
    events: set.has('events'),
    pty: set.has('pty'),
    fileWrite: false,
    diff: set.has('diff'),
    todo: set.has('todo'),
    permissions: set.has('permissions'),
  };
}
