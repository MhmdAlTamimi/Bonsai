import { useEffect, useRef, useState } from 'react';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { COMPARE_MAX } from './compare.ts';

export interface ComparePicking {
  /** Null when not picking, which is what the map reads to decide whether a click selects or picks. */
  picks: string[] | null;
  busy: boolean;
  error: string | null;
  /** The open comparison, which the address bar carries. */
  comparing: string | null;
  open: (comparisonId: string | null) => void;
  pick: (id: string) => void;
  setPicking: (on: boolean) => void;
  compare: () => void;
}

/**
 * Comparing: picking experiments on the map, then the comparison itself.
 *
 * A card clicked while picking, or ⌘/Ctrl/Shift-clicked at any time, is a
 * pick. Picking that way starts from the experiment already open, which is
 * usually the one you want to compare against.
 */
export function useComparePicking(
  projectId: string | null,
  primary: string | null,
  arrivedAt: string | null,
): ComparePicking {
  const [picks, setPicks] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparing, setComparing] = useState<string | null>(arrivedAt);

  // Another project is another set of experiments: nothing picked carries over.
  const shownProject = useRef(projectId);
  useEffect(() => {
    if (shownProject.current === projectId) return;
    shownProject.current = projectId;
    setPicks(null);
    setComparing(null);
  }, [projectId]);

  // Escape stops picking, unless a dialog or menu has it.
  useEffect(() => {
    if (picks === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || document.querySelector('dialog[open]') !== null) return;
      setPicks(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picks]);

  return {
    picks,
    busy,
    error,
    comparing,
    open: setComparing,
    pick: (id) => {
      setError(null);
      setPicks((current) => {
        const list = current ?? (primary !== null && primary !== id ? [primary] : []);
        if (list.includes(id)) return list.filter((picked) => picked !== id);
        return list.length >= COMPARE_MAX ? list : [...list, id];
      });
    },
    setPicking: (on) => {
      setError(null);
      setPicks(on ? [] : null);
    },
    compare: () => {
      if (projectId === null || picks === null) return;
      setBusy(true);
      setError(null);
      api
        .createComparison(projectId, picks)
        .then((view) => {
          setPicks(null);
          setComparing(view.id);
        })
        .catch((e: unknown) => setError(describeError(e)))
        .finally(() => setBusy(false));
    },
  };
}
