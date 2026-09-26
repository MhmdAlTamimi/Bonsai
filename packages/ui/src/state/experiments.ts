import { createContext, useContext, useMemo } from 'react';
import type { NodeView } from '@bonsai/shared';

/**
 * The open project's experiments, and a way to go to one, for the places that
 * mention an experiment by name: the composer's `@`, and a message's chips.
 * A context for the same reason references have one -- they sit far from the
 * tree that owns the list.
 */
export interface Experiments {
  list: readonly NodeView[];
  byId: ReadonlyMap<string, NodeView>;
  /** Select it on the map and show its conversation. */
  open: (id: string) => void;
}

export const ExperimentsContext = createContext<Experiments>({
  list: [],
  byId: new Map(),
  open: () => undefined,
});

export const useExperiments = (): Experiments => useContext(ExperimentsContext);

/** The context's value for a tree: rebuilt when the list changes, not on every render. */
export function useExperimentList(
  nodes: readonly NodeView[] | undefined,
  open: (id: string) => void,
): Experiments {
  return useMemo<Experiments>(
    () => ({
      list: nodes ?? [],
      byId: new Map((nodes ?? []).map((node) => [node.id, node])),
      open,
    }),
    // `open` selects and shows; its identity does not matter, the list does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes],
  );
}
