import { useState } from 'react';
import type { NodeView, RecoverAction } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';

/**
 * The four things the panel can do to a node.
 *
 * Together because they share exactly one shape -- set busy, call the server,
 * report what went wrong, refetch -- and apart from the panel because that
 * shape is the whole of them, while the panel is about arrangement.
 */
export function useNodeActions(
  node: NodeView,
  onChanged: () => void,
  onError: (message: string | null) => void,
): {
  busy: boolean;
  childName: string;
  setChildName: (value: string) => void;
  childDesc: string;
  setChildDesc: (value: string) => void;
  createChild: () => Promise<void>;
  recover: (action: RecoverAction) => Promise<void>;
  remove: () => Promise<void>;
  cancel: () => Promise<void>;
} {
  const [childName, setChildName] = useState('');
  const [childDesc, setChildDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const setError = onError;

  const createChild = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const { node: child } = await api.createNode(node.projectId, {
        parentId: node.id,
        displayName: childName.trim() || 'untitled',
        description: childDesc.trim(),
      });
      await api.startRun(child.id, childDesc.trim() || childName.trim());
      setChildName('');
      setChildDesc('');
      onChanged();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const recover = async (action: RecoverAction): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
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
   * fetched and stated before asking — the cheap part of B9, worth having now.
   */
  const remove = async (): Promise<void> => {
    setError(null);
    try {
      const impact = await api.deletionImpact(node.id);
      const others = impact.nodes - 1;
      const spent = impact.costUsd > 0 ? `, about $${impact.costUsd.toFixed(2)} of agent runs` : '';
      const descendants = others > 0 ? ` and ${others} descendant${others === 1 ? '' : 's'}` : '';
      if (
        !window.confirm(
          `Delete "${node.displayName}"${descendants}?\n\n` +
            `This permanently removes ${impact.nodes} node${impact.nodes === 1 ? '' : 's'}${spent}, ` +
            `${impact.commits} commit-bearing branch${impact.commits === 1 ? '' : 'es'}, and their ` +
            `worktrees on disk. It cannot be undone.`,
        )
      ) {
        return;
      }
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

  return {
    busy,
    childName,
    setChildName,
    childDesc,
    setChildDesc,
    createChild,
    recover,
    remove,
    cancel,
  };
}
