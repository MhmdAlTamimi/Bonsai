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
  compact: (node: NodeView) => void;
  /** Opens a new reference drawn from this experiment's conversation. */
  reference: (node: NodeView) => void;
  details: (node: NodeView) => void;
  remove: (node: NodeView) => void;
}

export const CardActionsContext = createContext<CardActions | null>(null);

/** The accessible name of a card's ⋯ button, so the label and anything looking for it agree. */
export function cardMenuLabel(displayName: string): string {
  return `Actions for ${displayName}`;
}

/**
 * Where focus goes back to after a dialog opened from a card's ⋯ menu closes.
 * The menu item that opened it is gone by then, so the button is the target.
 */
export function cardMenuButton(displayName: string): string {
  return `[aria-label="${CSS.escape(cardMenuLabel(displayName))}"]`;
}

/**
 * Experiments picked for a comparison, by id, with their position -- which is
 * their colour and number on the card. Empty when nothing is being picked.
 */
export const PickContext = createContext<ReadonlyMap<string, number>>(new Map());
