// Renders the global toast queue (src/lib/toast.ts). Mounted once in App.
// Errors get role="alert" (assertive) so screen readers announce them
// immediately; info/success use a polite status region.

import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { toastStore } from '../lib/toast';

export function ToastViewport() {
  const items = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot);
  if (items.length === 0) return null;

  return (
    <div className="toast-viewport">
      {items.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="toast-text">{t.text}</span>
          <button
            type="button"
            className="toast-close"
            onClick={() => toastStore.dismiss(t.id)}
            aria-label="关闭提示"
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}
