import type { NodeStatus } from '@bonsai/shared';

/**
 * Legal node-state transitions (PRD §5). Five states; `failed` is not one of
 * them -- a failed run lands the node in `interrupted` and is distinguished by
 * `run.error`, per D31.
 *
 * `needs_you` is reachable in this table but unreachable in practice until the
 * ask-user mechanism lands (postponed; see docs/v0-open-items.md). The state and
 * its transitions ship now so the schema and the panel do not need rebuilding.
 */
const TRANSITIONS: Record<NodeStatus, readonly NodeStatus[]> = {
  new: ['running', 'interrupted'],
  running: ['ready', 'needs_you', 'interrupted'],
  needs_you: ['running', 'interrupted'],
  ready: ['running'],
  interrupted: ['running', 'ready'],
};

export function canTransition(from: NodeStatus, to: NodeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: NodeStatus, to: NodeStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal node transition ${from} -> ${to}`);
  }
}

/** A run in one of these states is still holding the node. */
export function isTerminal(status: NodeStatus): boolean {
  return status === 'ready' || status === 'interrupted';
}
