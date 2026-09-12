import type { JSX } from 'react';
import type { NodeLineageView } from '@bonsai/shared';

/**
 * Where this node's code came from, and where its conversation came from.
 *
 * PRD §4 calls the gap between those two the point of the product, and the
 * decision log calls it the single easiest thing in the design to get subtly
 * wrong -- and the panel for the node it happens to said nothing about it at
 * all. You could look straight at a child of an exploration node and see no
 * hint that its code had skipped a generation.
 *
 * Quiet when the two agree, which is most nodes: one line, muted, stating the
 * obvious cheaply. Loud when they diverge, because that is the case nobody
 * predicts and everybody has to reason about.
 */
export function Lineage({ lineage }: { lineage: NodeLineageView }): JSX.Element | null {
  const { conversationFrom, codeFrom, diverged } = lineage;
  // Master: nothing above it, so there is nothing to say.
  if (conversationFrom === null) return null;

  if (!diverged) {
    return (
      <p className="lineage">
        Branched from <strong>{conversationFrom.displayName}</strong>
        {codeFrom === null && ' — which has no commits yet'}.
      </p>
    );
  }

  return (
    <p className="lineage diverged">
      Conversation from <strong>{conversationFrom.displayName}</strong>, code from{' '}
      <strong>{codeFrom?.displayName}</strong>
      {' — '}
      {conversationFrom.displayName} changed no files, so there was nothing to branch from.
    </p>
  );
}
