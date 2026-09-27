import { useEffect } from 'react';

/** The text size preference, as the `--text-scale` every size in the stylesheet multiplies by. */
export function useTextScale(percent: number | undefined): void {
  useEffect(() => {
    document.documentElement.style.setProperty('--text-scale', String((percent ?? 100) / 100));
  }, [percent]);
}
