import { useState, type JSX } from 'react';
import type { NodeView } from '@bonsai/shared';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';

export function DeletionRecovery({
  node,
  onChanged,
  onError,
}: {
  node: NodeView;
  onChanged: () => void;
  onError: (error: string | null) => void;
}): JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const deletion = node.deletion;
  if (!deletion) return null;
  const act = async (cancel: boolean): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      if (cancel) await api.cancelDeletion(deletion.id);
      else if (deletion.kind === 'project') await api.deleteProject(node.projectId);
      else await api.deleteNode(deletion.rootNodeId!);
      onChanged();
    } catch (error) {
      onError(describeError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="recover" aria-label="Paused deletion">
      <p className="recover-headline">Deletion is paused</p>
      <p className="hint">
        {deletion.error ?? 'Bonsai closed during deletion. The remaining cleanup can be retried.'}
      </p>
      <p className="hint">
        New runs are blocked while deletion is pending. Cancelling stops the remaining cleanup;
        already removed files do not return. Saved code can be recovered if its Git objects are
        still available.
      </p>
      <div className="row">
        <button disabled={busy} onClick={() => void act(false)}>
          Finish deletion
        </button>
        <button disabled={busy} onClick={() => void act(true)}>
          Cancel remaining deletion
        </button>
      </div>
    </section>
  );
}
