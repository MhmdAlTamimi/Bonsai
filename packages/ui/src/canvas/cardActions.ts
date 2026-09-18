import { createContext } from 'react';
import type { NodeView } from '@bonsai/shared';

/**
 * What a card can do to its own experiment.
 *
 * A context rather than props because React Flow renders the cards itself and
 * gives them nothing but their data. These are the actions the design puts on
 * the card — its `+`, its Review control and its ⋯ — and they are the only
 * place those actions live now: the panel is for reading the conversation.
 */
export interface CardActions {
  branch: (nodeId: string) => void;
  review: (nodeId: string) => void;
  rename: (node: NodeView) => void;
  remove: (node: NodeView) => void;
}

export const CardActionsContext = createContext<CardActions | null>(null);
