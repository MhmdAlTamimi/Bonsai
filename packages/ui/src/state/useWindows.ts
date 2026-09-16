import { useCallback, useSyncExternalStore } from 'react';

import { fitAll, NO_WINDOWS, type Area, type Windows } from './windows.ts';

/**
 * Each experiment's diff windows, for this session only (D44).
 *
 * Module state rather than component state, like drafts: the panel that opens
 * a window and the layer that draws it are far apart, and both must survive
 * switching experiments -- switching hides one experiment's windows and
 * coming back finds them where they were. Never browser storage.
 */
const byExperiment = new Map<string, Windows>();
const listeners = new Set<() => void>();
/** The map area, as last measured by the layer. Opening a window needs it before the layer redraws. */
let area: Area = { width: 960, height: 640 };

export const windowsKey = (projectId: string, nodeId: string): string =>
  JSON.stringify([projectId, nodeId]);

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readWindows(key: string | null): Windows {
  return key === null ? NO_WINDOWS : (byExperiment.get(key) ?? NO_WINDOWS);
}

export function changeWindows(key: string, change: (state: Windows, area: Area) => Windows): void {
  const before = readWindows(key);
  const after = change(before, area);
  if (after === before) return;
  byExperiment.set(key, after);
  emit();
}

/** The layer reports the map's size; every experiment's windows are kept on it. */
export function setWindowArea(next: Area): void {
  // A hidden map measures as nothing. Fitting windows to that would crush
  // them, so the last real size stands until the map is back.
  if (next.width === 0 || next.height === 0) return;
  if (next.width === area.width && next.height === area.height) return;
  area = next;
  let changed = false;
  for (const [key, state] of byExperiment) {
    const fitted = fitAll(state, area);
    if (fitted !== state) {
      byExperiment.set(key, fitted);
      changed = true;
    }
  }
  if (changed) emit();
}

export function useWindows(key: string | null): {
  windows: Windows;
  change: (change: (state: Windows, area: Area) => Windows) => void;
} {
  const windows = useSyncExternalStore(
    subscribe,
    () => readWindows(key),
    () => readWindows(key),
  );
  const change = useCallback(
    (fn: (state: Windows, area: Area) => Windows) => {
      if (key !== null) changeWindows(key, fn);
    },
    [key],
  );
  return { windows, change };
}
