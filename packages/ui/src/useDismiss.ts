import { useEffect, type RefObject } from 'react';

/**
 * Click away or press Escape, and the thing you opened closes.
 *
 * Every menu and popover in the app needs exactly this, and three of them had
 * their own copy -- which is how one of them ends up without the Escape half
 * and nobody notices until they press it. The rule is the same everywhere, so
 * it lives in one place.
 *
 * MOUSEDOWN, not click. A click fires after the button that opened the popover
 * has already handled its own mousedown; listening for clicks would close the
 * popover during the same gesture that opened it.
 *
 * Focus goes back to the trigger on Escape. Without it the keyboard lands at
 * the top of the document, which is a worse place than where it started -- and
 * only on Escape: a click away has already put focus somewhere the user chose.
 */
export function useDismiss(
  open: boolean,
  close: () => void,
  /** The popover and its trigger. A press inside this does not dismiss. */
  container: RefObject<HTMLElement | null>,
  /** Selector for the trigger within the container, focused when Escape closes. */
  triggerSelector?: string,
): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!container.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close();
      if (triggerSelector !== undefined)
        container.current?.querySelector<HTMLElement>(triggerSelector)?.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close, container, triggerSelector]);
}
