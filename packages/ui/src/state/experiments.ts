import { createContext, useContext } from 'react';
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
