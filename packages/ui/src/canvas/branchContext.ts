import { createContext } from 'react';

/**
 * How a card's `+` asks for a new experiment, since React Flow renders cards
 * itself and gives them no props but their data. Null outside a canvas.
 */
export const BranchContext = createContext<((parentId: string) => void) | null>(null);
