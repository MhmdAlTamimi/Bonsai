import { useCallback, useState } from 'react';

/**
 * PRD §9 constraint 2: selection is a list, not a single node.
 *
 * V0 only ever reads the first element, but compare-mode (B8) otherwise touches
 * every component that renders a selection. Keeping the array shape now costs
 * nothing; retrofitting it later costs everything.
 */
export interface Selection {
  ids: readonly string[];
  primary: string | null;
  select: (id: string) => void;
  toggle: (id: string) => void;
  clear: () => void;
}

export function useSelection(): Selection {
  const [ids, setIds] = useState<readonly string[]>([]);

  const select = useCallback((id: string) => setIds([id]), []);
  const toggle = useCallback(
    (id: string) =>
      setIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id])),
    [],
  );
  const clear = useCallback(() => setIds([]), []);

  return { ids, primary: ids[0] ?? null, select, toggle, clear };
}
