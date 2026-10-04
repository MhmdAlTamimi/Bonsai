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
        Runs are paused. Cancelling stops cleanup; files already removed stay deleted. Saved code is
        recoverable while its Git history is available.
      </p>
      <div className="row">
        <button disabled={busy} onClick={() => void act(false)}>
          Finish deletion
        </button>
        <button disabled={busy} onClick={() => void act(true)}>
          Cancel deletion
        </button>
      </div>
    </section>
  );
}
