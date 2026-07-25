// Modal — the shared base for every blocking overlay in the app.
//
// It bundles the four things ad-hoc modals kept missing:
//   1. Hides the embedded browser WebContentsView while open (it paints
//      above all renderer HTML — without this the modal can be unreachable).
//   2. role="dialog" + aria-modal, with an aria-label / aria-labelledby hook.
//   3. Escape-to-close (opt-out via closeOnEscape={false} for modal flows
//      that require an explicit decision, e.g. the plan review).
//   4. A minimal focus trap: initial focus lands inside the panel, Tab wraps
//      at both ends, and focus returns to the previously focused element on
//      close.
//
// Visual styling stays with the caller: pass the existing backdrop/panel
// class names so each modal keeps its look.

import { useEffect, useRef, type ReactNode } from 'react';
import { requestHideBrowser } from '../lib/browser-store';

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  open: boolean;
  /** Called on Escape / backdrop click (when enabled). */
  onClose?: () => void;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  /** Class for the fixed backdrop element. Defaults to "modal-backdrop". */
  backdropClassName?: string;
  /** Class for the dialog panel. Existing panel classes go here. */
  className?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onClose,
  closeOnEscape = true,
  closeOnBackdrop = true,
  backdropClassName,
  className,
  ariaLabel,
  ariaLabelledBy,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Hide the native browser view for the whole time the modal is mounted.
  useEffect(() => {
    if (!open) return;
    return requestHideBrowser();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    // Move focus inside the dialog on open. Prefer an element the caller
    // marked for initial focus, then any focusable control, then the panel.
    const target = panel.querySelector<HTMLElement>('[data-autofocus]')
      ?? panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      ?? panel;
    target.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (closeOnEscape && onClose) {
          e.stopPropagation();
          onClose();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to whatever had it before the modal opened.
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  return (
    <div
      className={backdropClassName ?? 'modal-backdrop'}
      onClick={closeOnBackdrop && onClose ? onClose : undefined}
    >
      <div
        ref={panelRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
