import type { NodeView } from '@bonsai/shared';

/**
 * Whether a node has code, from the UI's point of view.
 *
 * `createsBranch` is an outcome, so it only means anything once a run has
 * finished. Before that the answer is genuinely unknown, and saying "no commits
 * — conversation only" about a node that has not run yet is a claim we cannot
 * make: it may well write code the moment it starts.
 *
 * Only `ready` is conclusive. `new` has not run, `running` and `needs_you` are
 * mid-run, and `interrupted` died before we could tell.
 */
export type CodeState = 'has-commits' | 'none' | 'unknown';

export function codeState(node: NodeView): CodeState {
  if (node.hasCommits) return 'has-commits';
  return node.status === 'ready' ? 'none' : 'unknown';
}

export const CODE_LABEL: Record<CodeState, string> = {
  'has-commits': 'has commits',
  none: 'no commits — conversation only',
  unknown: 'not run yet — unknown',
};
