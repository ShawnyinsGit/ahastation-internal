// opencode-editor-adapter.ts — EditorIdeAdapter implementation for OpenCode
// (plus Hermes/Pi stubs that prove a second IDE only needs the interface).
//
// attach() opens the editor window via the IDE-agnostic window manager; the
// capabilities tell the renderer which panels to show. All server
// credentials stay in main (spawn / event pipeline / permission bridge live
// in electron/backends/opencode-*.ts) — nothing crosses into the renderer.

import {
  NO_EDITOR_CAPABILITIES,
  type EditorIdeAdapter,
  type EditorIdeAttachOptions,
  type EditorIdeCapabilities,
  type IdeEditorHandle,
} from '../ide-adapter.js';
import { closeEditorWindow, createEditorWindow } from '../ide-window-manager.js';

export const OPENCODE_EDITOR_CAPABILITIES: EditorIdeCapabilities = {
  events: true,
  pty: true,
  fileWrite: false,
  diff: true,
  todo: true,
  permissions: true,
};

export class OpenCodeEditorAdapter implements EditorIdeAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode';
  readonly capabilities = OPENCODE_EDITOR_CAPABILITIES;

  async attach(opts: EditorIdeAttachOptions): Promise<IdeEditorHandle> {
    createEditorWindow({ ...opts, capabilities: this.capabilities });
    return {
      capabilities: this.capabilities,
      close: () => closeEditorWindow(opts.hostId),
    };
  }
}

/** Stub adapter for IDEs without a server API yet (Hermes / Pi). Every
 *  capability is false — the editor degrades to fs browsing only and the
 *  Settings panel lists them as 即将支持. attach() still works so the
 *  degrade path is exercisable end-to-end. */
export class StubEditorAdapter implements EditorIdeAdapter {
  readonly capabilities = NO_EDITOR_CAPABILITIES;

  constructor(
    readonly id: string,
    readonly displayName: string,
  ) {}

  async attach(opts: EditorIdeAttachOptions): Promise<IdeEditorHandle> {
    createEditorWindow({ ...opts, capabilities: this.capabilities });
    return {
      capabilities: this.capabilities,
      close: () => closeEditorWindow(opts.hostId),
    };
  }
}
