import { useCallback, useState } from 'react';

import { api } from '../api/client.ts';
import { draftKey, setSending } from '../panel/chat/drafts.ts';
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

/** Everything the create dialog decided. */
export interface NewChild {
  name: string;
  description: string;
  successCriteria: string;
  verificationHint: string;
  sourceVersion: string;
  /** Start the first run now, rather than saving the experiment for later. */
  startNow: boolean;
  /** Leave the parent's conversation behind. The code is inherited either way. */
  startFresh: boolean;
}

export function useChildCreation(opts: {
  projectId: string | null;
  onCreated: (nodeId: string) => void;
  onError: (message: string) => void;
  refresh: () => void;
}): {
  /** Non-null while the dialog is open. */
  pending: ChildTarget | null;
  failedStart: { nodeId: string; message: string } | null;
  clearStartError: (nodeId: string) => void;
  begin: (target: ChildTarget) => void;
  cancel: () => void;
  create: (child: NewChild) => Promise<void>;
} {
  const [failedStart, setFailedStart] = useState<{ nodeId: string; message: string } | null>(null);
  const [pending, setPending] = useState<ChildTarget | null>(null);
  const { projectId, onCreated, onError, refresh } = opts;

  const create = useCallback(
    async ({
      name,
      description,
      successCriteria,
      verificationHint,
      sourceVersion,
      startNow,
      startFresh,
    }: NewChild): Promise<void> => {
      if (pending === null || projectId === null) return;
      const { node } = await api.createNode(projectId, {
        parentId: pending.parentId,
        displayName: name,
        description,
        successCriteria,
        verificationHint,
        sourceVersion,
        startFresh,
      });
      const draft = draftKey(projectId, node.id, 'reply');
      setSending(draft, true);
      // Creation is confirmed. A later placement/start error must not lose the node.
      setPending(null);
      onCreated(node.id);
      refresh();
      if (pending.position !== null) {
        try {
          await api.updateNode(node.id, {
            positionX: pending.position.x,
            positionY: pending.position.y,
          });
        } catch (e) {
          onError(`Experiment created; could not save its position. ${describeError(e)}`);
        }
      }
      try {
        if (startNow) await api.startRun(node.id, description);
      } catch (e) {
        setFailedStart({
          nodeId: node.id,
          message: `"${name}" was created, but its run did not start. Use Start first run to retry. ${describeError(e)}`,
        });
      }
      setSending(draft, false);
      refresh();
    },
    [pending, projectId, onCreated, onError, refresh],
  );

  return {
    pending,
    failedStart,
    clearStartError: (nodeId: string) =>
      setFailedStart((value) => (value?.nodeId === nodeId ? null : value)),
    begin: useCallback((target: ChildTarget) => setPending(target), []),
    cancel: useCallback(() => setPending(null), []),
    create,
  };
}
