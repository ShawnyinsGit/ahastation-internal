// StageWindow store — manages dynamic multi-window tabs in the stage area.
// Follows the same subscribe/getSnapshot pattern as browser-store for
// useSyncExternalStore compatibility.

import { browserStore } from './browser-store';

export type StageWindowType = 'activity' | 'browser' | 'terminal' | 'file';

export interface StageWindow {
  id: string;
  type: StageWindowType;
  title: string;
  browserTabId?: string;
  filePath?: string;
  /** For terminal windows: the worker id whose activity should be displayed */
  workerId?: string;
}

export interface StageWindowState {
  windows: StageWindow[];
  activeWindowId: string | null;
}

type Listener = () => void;

let nextId = 1;
function genId(): string {
  return `sw-${Date.now()}-${nextId++}`;
}

const ACTIVITY_TAB_ID = 'activity-default';

const initialState: StageWindowState = {
  windows: [{ id: ACTIVITY_TAB_ID, type: 'activity', title: '工作区' }],
  activeWindowId: ACTIVITY_TAB_ID,
};

class StageWindowStore {
  private state: StageWindowState = { ...initialState };
  private listeners = new Set<Listener>();
  private browserUnsubs = new Map<string, () => void>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): StageWindowState => this.state;

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  private update(partial: Partial<StageWindowState>): void {
    this.state = { ...this.state, ...partial };
    this.notify();
  }

  async createWindow(type: StageWindowType, opts?: { workerId?: string; title?: string }): Promise<void> {
    if (type === 'activity') {
      this.setActiveWindow(ACTIVITY_TAB_ID);
      return;
    }

    const id = genId();

    if (type === 'browser') {
      const tab = await browserStore.openTab();
      if (!tab) return;
      const window: StageWindow = {
        id,
        type: 'browser',
        title: '新标签页',
        browserTabId: tab.id,
      };
      const unsub = browserStore.subscribe(() => {
        const snap = browserStore.getSnapshot();
        const bTab = snap.tabs.find((t) => t.id === tab.id);
        if (bTab) {
          const current = this.state.windows.find((w) => w.id === id);
          if (current && current.title !== bTab.title && bTab.title !== '新标签页') {
            this.update({
              windows: this.state.windows.map((w) =>
                w.id === id ? { ...w, title: bTab.title } : w,
              ),
            });
          }
        }
      });
      this.browserUnsubs.set(id, unsub);
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
      await browserStore.setActiveTab(tab.id);
    } else if (type === 'terminal') {
      // Terminal windows can be associated with a specific worker whose
      // activity should be rendered. Multiple terminal tabs are allowed.
      const window: StageWindow = {
        id,
        type: 'terminal',
        title: opts?.title ?? '终端',
        workerId: opts?.workerId,
      };
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
    } else {
      const title = '文件';
      const window: StageWindow = { id, type, title };
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
    }
  }

  async closeWindow(id: string): Promise<void> {
    if (id === ACTIVITY_TAB_ID) return;
    const win = this.state.windows.find((w) => w.id === id);
    if (!win) return;

    if (win.type === 'browser' && win.browserTabId) {
      // Clean up the browser title subscription to prevent memory leak
      const unsub = this.browserUnsubs.get(id);
      if (unsub) {
        unsub();
        this.browserUnsubs.delete(id);
      }
      await browserStore.closeTab(win.browserTabId);
    }

    const newWindows = this.state.windows.filter((w) => w.id !== id);
    let newActiveId = this.state.activeWindowId;
    if (newActiveId === id) {
      newActiveId = newWindows.length > 0
        ? newWindows[newWindows.length - 1].id
        : ACTIVITY_TAB_ID;
    }

    this.update({ windows: newWindows, activeWindowId: newActiveId });

    if (newActiveId) {
      const nextWin = newWindows.find((w) => w.id === newActiveId);
      if (nextWin?.type === 'browser' && nextWin.browserTabId) {
        await browserStore.setActiveTab(nextWin.browserTabId);
        await browserStore.setVisible(true);
      } else {
        await browserStore.setVisible(false);
      }
    }
  }

  async setActiveWindow(id: string): Promise<void> {
    const win = this.state.windows.find((w) => w.id === id);
    if (!win) return;

    // Hide browser overlay when switching away from a browser tab
    const prevWin = this.state.windows.find((w) => w.id === this.state.activeWindowId);
    if (prevWin?.type === 'browser' && win.type !== 'browser') {
      await browserStore.setVisible(false);
    }

    this.update({ activeWindowId: id });

    if (win.type === 'browser' && win.browserTabId) {
      await browserStore.setActiveTab(win.browserTabId);
      await browserStore.setVisible(true);
    }
  }

  renameWindow(id: string, title: string): void {
    this.update({
      windows: this.state.windows.map((w) =>
        w.id === id ? { ...w, title } : w,
      ),
    });
  }

  async openFile(filePath: string): Promise<void> {
    const fileName = filePath.split('/').pop() || filePath;
    const ext = fileName.split('.').pop()?.toLowerCase();

    // Route HTML files through the embedded browser for rich rendering
    // instead of the file viewer (which uses a restrictive sandbox iframe).
    if (ext === 'html' || ext === 'htm') {
      await this.openHtmlInBrowser(filePath, fileName);
      return;
    }

    // Dedup: if a file tab for this exact path is already open, just focus it.
    const existing = this.state.windows.find((w) => w.type === 'file' && w.filePath === filePath);
    if (existing) {
      await this.setActiveWindow(existing.id);
      return;
    }

    // Hide browser overlay if currently active
    const prevWin = this.state.windows.find((w) => w.id === this.state.activeWindowId);
    if (prevWin?.type === 'browser') {
      await browserStore.setVisible(false);
    }

    const id = genId();
    const window: StageWindow = { id, type: 'file', title: fileName, filePath };
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
  }

  /** Open an HTML file in a browser stage tab using a file:// URL. */
  private async openHtmlInBrowser(filePath: string, fileName: string): Promise<void> {
    // Check if we already have a browser tab open for this file
    const fileUrl = `file://${filePath}`;
    const existingBrowserWin = this.state.windows.find(
      (w) => w.type === 'browser' && w.filePath === filePath,
    );
    if (existingBrowserWin) {
      await this.setActiveWindow(existingBrowserWin.id);
      return;
    }

    const tab = await browserStore.openTab(fileUrl);
    if (!tab) {
      // Fallback to file viewer if browser fails
      await this.openFileAsRegularFile(filePath, fileName);
      return;
    }

    const id = genId();
    const window: StageWindow = {
      id,
      type: 'browser',
      title: fileName,
      browserTabId: tab.id,
      filePath, // store filePath for dedup detection
    };

    // Subscribe to browser title updates
    const unsub = browserStore.subscribe(() => {
      const snap = browserStore.getSnapshot();
      const bTab = snap.tabs.find((t) => t.id === tab.id);
      if (bTab) {
        const current = this.state.windows.find((w) => w.id === id);
        if (current && current.title !== bTab.title && bTab.title !== '新标签页') {
          this.update({
            windows: this.state.windows.map((w) =>
              w.id === id ? { ...w, title: bTab.title } : w,
            ),
          });
        }
      }
    });
    this.browserUnsubs.set(id, unsub);
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
    await browserStore.setActiveTab(tab.id);
  }

  /** Fallback: open as a regular file tab (non-HTML path). */
  private async openFileAsRegularFile(filePath: string, fileName: string): Promise<void> {
    const id = genId();
    const window: StageWindow = { id, type: 'file', title: fileName, filePath };
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
  }

  removeByType(type: StageWindowType): void {
    const toRemove = this.state.windows.filter((w) => w.type === type);
    for (const w of toRemove) {
      void this.closeWindow(w.id);
    }
  }
}

export const stageWindowStore = new StageWindowStore();
