// Global toast channel — the single place transient user-facing feedback
// should go. Rendered by <ToastViewport /> mounted once in App. Replaces the
// scattered "console.warn only" failure paths: any async IPC whose result the
// user cares about should surface failures here.
//
// Kept dependency-free (no React import) so stores and lib modules can raise
// toasts without pulling in component code.

export type ToastKind = 'error' | 'info' | 'success';

export interface ToastEntry {
  id: number;
  kind: ToastKind;
  text: string;
}

type Listener = () => void;

const MAX_TOASTS = 4;

class ToastStore {
  private items: ToastEntry[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ToastEntry[] => this.items;

  push(kind: ToastKind, text: string, ttlMs = kind === 'error' ? 6000 : 4200): number {
    const trimmed = text.trim();
    if (!trimmed) return -1;
    const id = this.nextId++;
    // Drop the oldest when full so a fresh error is never invisible.
    if (this.items.length >= MAX_TOASTS) this.dismiss(this.items[0].id);
    this.items = [...this.items, { id, kind, text: trimmed }];
    this.timers.set(id, setTimeout(() => this.dismiss(id), ttlMs));
    this.notify();
    return id;
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    if (!this.items.some((t) => t.id === id)) return;
    this.items = this.items.filter((t) => t.id !== id);
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* listener errors must not break the store */ }
    }
  }
}

const store = new ToastStore();

export const toastStore = store;

/** Imperative helpers — safe to call from anywhere, including non-React code. */
export const toast = {
  error: (text: string) => store.push('error', text),
  info: (text: string) => store.push('info', text),
  success: (text: string) => store.push('success', text),
};
