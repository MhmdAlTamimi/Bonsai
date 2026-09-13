import { useState, type JSX } from 'react';
import type { NodeView, RecoverAction } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { useConfirm } from '../../ConfirmDialog.tsx';

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
 */
export function useNodeActions(
  node: NodeView,
  onChanged: () => void,
  onError: (message: string | null) => void,
): {
  busy: boolean;
  recover: (action: RecoverAction) => Promise<void>;
  remove: () => Promise<void>;
  cancel: () => Promise<void>;
  /** Render this in the panel; null unless something is being confirmed. */
  confirmDialog: JSX.Element | null;
} {
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const setError = onError;

  const recover = async (action: RecoverAction): Promise<void> => {
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
  const remove = async (): Promise<void> => {
    setError(null);
    try {
      const impact = await api.deletionImpact(node.id);
      const others = impact.nodes - 1;
      const spent = impact.costUsd > 0 ? `, about $${impact.costUsd.toFixed(2)} of agent runs` : '';
      const descendants = others > 0 ? ` and ${others} descendant${others === 1 ? '' : 's'}` : '';
      const ok = await confirm.ask({
        title: `Delete "${node.displayName}"${descendants}?`,
        body: [
          `This permanently removes ${impact.nodes} node${impact.nodes === 1 ? '' : 's'}${spent}, ` +
            `${impact.commits} commit-bearing branch${impact.commits === 1 ? '' : 'es'}, and their ` +
            'worktrees on disk.',
          'It cannot be undone.',
        ],
        confirmLabel: 'Delete',
        danger: true,
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

  /**
   * Stop the node, not a run.
   *
   * This used to hunt for the running run inside `detail` and return silently
   * when it had not arrived yet -- so pressing stop early did nothing at all,
   * with no error, while the agent kept spending. Cancelling by node id needs
   * nothing fetched, so there is no window in which the button is a no-op.
   */
  const cancel = async (): Promise<void> => {
    try {
      await api.cancelNode(node.id);
      onChanged();
    } catch (e) {
      setError(describeError(e));
    }
  };

  return { busy, recover, remove, cancel, confirmDialog: confirm.dialog };
}
