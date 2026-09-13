import { useCallback, useState } from 'react';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

/**
 * Creating a child, from wherever it was asked for.
 *
 * Three server calls that have to happen in order and are one action from the
 * user's side: create the node, pin it where they dropped it, start its first
 * run. Kept together so nothing can do two of the three.
 *
 * `position` is nullable because the gesture is no longer the only door. A drag
 * onto empty canvas says where the node goes; the panel's button does not, and
 * a node with no pinned position is laid out by dagre -- which is the documented
 * default (PRD §9), not a fallback.
 */
export interface ChildTarget {
  parentId: string;
  parentName: string;
  /** Where the user dropped it, or null to let auto-layout decide. */
  position: { x: number; y: number } | null;
}

export function useChildCreation(opts: {
  projectId: string | null;
  onCreated: (nodeId: string) => void;
  onError: (message: string) => void;
  refresh: () => void;
}): {
  /** Non-null while the dialog is open. */
  pending: ChildTarget | null;
  begin: (target: ChildTarget) => void;
  cancel: () => void;
  create: (
    name: string,
    description: string,
    successCriteria: string,
    verificationHint: string,
  ) => Promise<void>;
} {
  const [pending, setPending] = useState<ChildTarget | null>(null);
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
        if (pending.position !== null) {
          await api.updateNode(node.id, {
            positionX: pending.position.x,
            positionY: pending.position.y,
          });
        }
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
    begin: useCallback((target: ChildTarget) => setPending(target), []),
    cancel: useCallback(() => setPending(null), []),
    create,
  };
}
