import type { NodeStatus } from '@bonsai/shared';

/**
 * Legal node-state transitions (PRD §5). Five states; `failed` is not one of
 * them -- a failed run lands the node in `interrupted` and is distinguished by
 * `run.error`, per D31.
 *
 * `needs_you` is what a run parked on a question looks like (PRD 5, D34). The
 * mechanism is the permission callback: under the `default` permission mode a
 * tool call is held until the user answers, and the node sits in `needs_you`
 * until they do. Both edges are used -- `running -> needs_you` when it asks,
 * and either `needs_you -> running` on an answer or `-> interrupted` if the
 * node is stopped while parked.
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
