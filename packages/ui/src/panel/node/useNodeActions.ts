import { useState, type JSX } from 'react';
import type { NodeView, RecoverAction } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { useConfirm } from '../../ConfirmDialog.tsx';
import { cardMenuButton } from '../../canvas/cardActions.ts';
import { plural } from '../../words.ts';

/**
 * The things the panel can do to a node.
 *
 * Together because they share exactly one shape -- set busy, call the server,
 * report what went wrong, refetch -- and apart from the panel because that
 * shape is the whole of them, while the panel is about arrangement.
 *
 * Creating a child used to live here too, backing a second, weaker version of
 * the new-child form. It does not any more: there is one creation dialog and
 * the panel opens it (see Panel.tsx and NewChildDialog.tsx).
 *
 * The node is an argument rather than bound at the hook, because the same
 * actions are reached from two places now: the panel, for the experiment it is
 * showing, and a card's ⋯ on the map, for whichever card it belongs to.
 */
export function useNodeActions(
  onChanged: () => void,
  onError: (message: string | null) => void,
): {
  busy: boolean;
  recover: (node: NodeView, action: RecoverAction) => Promise<void>;
  remove: (node: NodeView) => Promise<void>;
  /** Render this in the panel; null unless something is being confirmed. */
  confirmDialog: JSX.Element | null;
} {
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const setError = onError;

  const recover = async (node: NodeView, action: RecoverAction): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      if (action === 'discard') {
        const detail = await api.node(node.id);
        const work = detail.partialWork;
        if (work === null)
          throw new Error('Partial changes could not be inspected. Retry before discarding.');
        const ok = await confirm.ask({
          title: `Discard partial changes in "${node.displayName}"?`,
          body: [
            'This permanently removes uncommitted changes, including new untracked files. Existing commits are kept.',
            ...work.changed.map(
              (path) =>
                `${path}${work.untracked.includes(path) ? ' (new, untracked — will be deleted)' : ' (will be reverted)'}`,
            ),
          ],
          confirmLabel: 'Discard partial changes',
          danger: true,
        });
        if (!ok) return;
      }
      await api.recover(node.id, action);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * D7 cascades to every descendant and B9 (soft delete) is deferred, so this
   * is irreversible and destroys paid, unreproducible work. The impact is
   * fetched and stated before asking -- the cheap part of B9, worth having now.
   */
  const remove = async (node: NodeView): Promise<void> => {
    setError(null);
    try {
      const impact = await api.deletionImpact(node.id);
      const others = impact.nodes - 1;

      const descendants = others > 0 ? ` and ${plural(others, 'descendant')}` : '';
      const ok = await confirm.ask({
        title: `Delete experiment "${node.displayName}"${descendants}?`,
        body: [
          `This permanently removes ${plural(impact.nodes, 'experiment')}, their conversations and run history, ` +
            'saved code, and their ' +
            'experiment folders on disk, including uncommitted files.',
          ...(others > 0 ? [`Affected experiments: ${impact.names.join(', ')}`] : []),
          'Other experiments and the project’s main folder are kept. This cannot be undone.',
        ],
        confirmLabel: others > 0 ? 'Delete experiment and descendants' : 'Delete experiment',
        danger: true,
        // Opened from the card's ⋯ menu; cancelling goes back to it.
        returnFocus: cardMenuButton(node.displayName),
      });
      if (!ok) return;
      setBusy(true);
      await api.deleteNode(node.id);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return { busy, recover, remove, confirmDialog: confirm.dialog };
}
