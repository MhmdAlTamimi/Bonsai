import { useEffect } from 'react';

/**
 * Escape closes the thing you are in.
 *
 * Shared rather than repeated: the new-child dialog had it and the settings
 * dialog did not, which is exactly the sort of inconsistency nobody notices
 * until they hit Escape and nothing happens.
 */
export function useEscape(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onEscape]);
}
