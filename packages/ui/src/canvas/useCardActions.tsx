import { useMemo, useState, type JSX } from 'react';
import type { NodeView } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import type { ConfirmRequest } from '../ConfirmDialog.tsx';

import { ApplyDialog } from '../panel/node/ApplyDialog.tsx';
import { CompactDialog } from '../panel/node/CompactDialog.tsx';
import { ExperimentDetails } from '../panel/node/DetailsDialog.tsx';
import { RenameDialog } from '../panel/node/RenameDialog.tsx';
import { useNodeActions } from '../panel/node/useNodeActions.ts';
import type { ReferenceTarget } from '../state/references.ts';
import type { ChildTarget } from '../state/useChildCreation.ts';
import { cardMenuButton, type CardActions } from './cardActions.ts';

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
  ask,
}: {
  nodes: readonly NodeView[] | undefined;
  refresh: () => void;
  report: (message: string) => void;
  branch: (target: ChildTarget) => void;
  review: (nodeId: string) => void;
  /** Select an experiment and show its conversation. */
  select: (nodeId: string) => void;
  openReference: (target: ReferenceTarget) => void;
  ask: (request: ConfirmRequest) => Promise<boolean>;
}): { actions: CardActions; dialogs: JSX.Element } {
  /**
   * Archive a folder. Straight away when nothing would be lost; the server
   * says what is in the way when something is, and ignored files that the
   * next run cannot bring back are listed and confirmed first.
   */
  const archive = async (node: NodeView): Promise<void> => {
    try {
      const check = await api.archiveCheck(node.id);
      if (check.blocked !== null) {
        report(`Could not archive ${node.displayName}: ${check.blocked}`);
        return;
      }
      if (check.ignored.length > 0) {
        const shown = check.ignored.slice(0, 8).join(', ');
        const more = check.ignored.length > 8 ? ` and ${check.ignored.length - 8} more` : '';
        const ok = await ask({
          title: `Archive ${node.displayName}?`,
          body: [
            'Archiving removes the folder to save space. Its branch, conversation and runs stay, and the next run brings the folder back.',
            `These ignored files would be deleted, and the next run cannot bring them back: ${shown}${more}.`,
          ],
          confirmLabel: 'Archive and delete them',
          danger: true,
          returnFocus: cardMenuButton(node.displayName),
        });
        if (!ok) return;
      }
      await api.archive(node.id, check.ignored.length > 0);
      refresh();
    } catch (e) {
      report(describeError(e));
    }
  };

  const [renaming, setRenaming] = useState<NodeView | null>(null);
  const [detailing, setDetailing] = useState<NodeView | null>(null);
  const [compacting, setCompacting] = useState<NodeView | null>(null);
  const [applying, setApplying] = useState<NodeView | null>(null);
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
      apply: setApplying,
      rename: setRenaming,
      compact: setCompacting,
      reference: (node) => openReference({ kind: 'new', sourceNodeId: node.id, draft: true }),
      details: setDetailing,
      archive: (node) => void archive(node),
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
      {applying !== null && (
        <ApplyDialog
          node={applying}
          onClose={() => setApplying(null)}
          returnFocus={cardMenuButton(applying.displayName)}
        />
      )}
      {nodeActions.confirmDialog}
    </>
  );
  return { actions, dialogs };
}
