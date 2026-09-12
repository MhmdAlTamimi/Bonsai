import { useCallback, useState } from 'react';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import type { DropTarget } from '../canvas/Canvas.tsx';

/**
 * Creating a child from a drag onto empty canvas.
 *
 * Three server calls that have to happen in order and are one action from the
 * user's side: create the node, pin it where they dropped it, start its first
 * run. Kept together so nothing can do two of the three.
 */
export function useChildCreation(opts: {
  projectId: string | null;
  onCreated: (nodeId: string) => void;
  onError: (message: string) => void;
  refresh: () => void;
}): {
  /** Non-null while the dialog is open. */
  pending: DropTarget | null;
  begin: (target: DropTarget) => void;
  cancel: () => void;
  create: (
    name: string,
    description: string,
    successCriteria: string,
    verificationHint: string,
  ) => Promise<void>;
} {
  const [pending, setPending] = useState<DropTarget | null>(null);
  const { projectId, onCreated, onError, refresh } = opts;

  const create = useCallback(
    async (
      name: string,
      description: string,
      successCriteria: string,
      verificationHint: string,
    ): Promise<void> => {
      if (pending === null || projectId === null) return;
      try {
        const { node } = await api.createNode(projectId, {
          parentId: pending.parentId,
          displayName: name,
          description,
          successCriteria,
          verificationHint,
        });
        // Pin it where it was dropped, so the gesture places the node.
        await api.updateNode(node.id, {
          positionX: pending.position.x,
          positionY: pending.position.y,
        });
        await api.startRun(node.id, description || name);
        setPending(null);
        onCreated(node.id);
        refresh();
      } catch (e) {
        onError(describeError(e));
        setPending(null);
      }
    },
    [pending, projectId, onCreated, onError, refresh],
  );

  return {
    pending,
    begin: useCallback((target: DropTarget) => setPending(target), []),
    cancel: useCallback(() => setPending(null), []),
    create,
  };
}
