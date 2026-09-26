import { useMemo, useState, type JSX } from 'react';
import type { NodeView } from '@bonsai/shared';

import { CompactDialog } from '../panel/node/CompactDialog.tsx';
import { ExperimentDetails } from '../panel/node/DetailsDialog.tsx';
import { RenameDialog } from '../panel/node/RenameDialog.tsx';
import { useNodeActions } from '../panel/node/useNodeActions.ts';
import type { ReferenceTarget } from '../state/references.ts';
import type { ChildTarget } from '../state/useChildCreation.ts';
import type { CardActions } from './cardActions.ts';

/**
 * The experiment actions a card's ⋯ offers, and the dialogs they open. They
 * live at the window rather than on the card because the cards are drawn by
 * the canvas and the dialogs belong to the window, not to any one card.
 */
export function useCardActions({
  nodes,
  refresh,
  report,
  branch,
  review,
  select,
  openReference,
}: {
  nodes: readonly NodeView[] | undefined;
  refresh: () => void;
  report: (message: string) => void;
  branch: (target: ChildTarget) => void;
  review: (nodeId: string) => void;
  /** Select an experiment and show its conversation. */
  select: (nodeId: string) => void;
  openReference: (target: ReferenceTarget) => void;
}): { actions: CardActions; dialogs: JSX.Element } {
  const [renaming, setRenaming] = useState<NodeView | null>(null);
  const [detailing, setDetailing] = useState<NodeView | null>(null);
  const [compacting, setCompacting] = useState<NodeView | null>(null);
  const nodeActions = useNodeActions(refresh, (message) => {
    if (message !== null) report(message);
  });
  const actions = useMemo<CardActions>(
    () => ({
      branch: (nodeId) => {
        const node = nodes?.find((n) => n.id === nodeId);
        if (node !== undefined)
          branch({ parentId: node.id, parentName: node.displayName, position: null });
      },
      review,
      rename: setRenaming,
      compact: setCompacting,
      reference: (node) => openReference({ kind: 'new', sourceNodeId: node.id, draft: true }),
      details: setDetailing,
      remove: (node) => void nodeActions.remove(node),
    }),
    // `branch` and `review` change identity on every render; the actions only
    // need to be rebuilt when the tree does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, nodeActions.remove],
  );

  const dialogs = (
    <>
      {renaming !== null && (
        <RenameDialog node={renaming} onClose={() => setRenaming(null)} onChanged={refresh} />
      )}
      {detailing !== null && (
        <ExperimentDetails node={detailing} onClose={() => setDetailing(null)} />
      )}
      {compacting !== null && (
        <CompactDialog
          node={compacting}
          onClose={() => setCompacting(null)}
          onStarted={(nodeId) => {
            // Show the conversation it is compacting, so the progress is visible.
            select(nodeId);
            refresh();
          }}
        />
      )}
      {nodeActions.confirmDialog}
    </>
  );
  return { actions, dialogs };
}
