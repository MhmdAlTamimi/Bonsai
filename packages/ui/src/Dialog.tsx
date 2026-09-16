import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Native focus containment and restoration for focused app tasks. */
export function Dialog({
  title,
  className = '',
  onClose,
  children,
  dismissOnBackdrop = false,
  returnFocus,
}: {
  title: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
  dismissOnBackdrop?: boolean;
  returnFocus?: string;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-dialog-focus]')?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else if (returnFocus) document.querySelector<HTMLElement>(returnFocus)?.focus();
    };
  }, [returnFocus]);
  return createPortal(
    <dialog
      ref={ref}
      className={`dialog ${className}`}
      aria-label={title}
      onKeyDown={(e) => {
        if (e.key !== 'Tab') return;
        const targets = Array.from(
          e.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const first = targets[0];
        const last = targets.at(-1);
        if (!first || !last) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (!dismissOnBackdrop || e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
          onClose();
      }}
    >
      {children}
    </dialog>,
    document.body,
  );
}
