import { useEffect, useState, type JSX } from 'react';
import type { RunReferenceView } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { Dialog, DialogHeader } from '../../Dialog.tsx';
import { referenceSize, useReferences } from '../../state/references.ts';

/**
 * A reference exactly as one message went with it: an experiment's run, or a
 * comparison's question (whose id is shown as a run's; the server tells them
 * apart).
 *
 * Each gets a copy, so what the agent read stays readable after the reference
 * is edited or deleted. This says which of those happened, and offers the
 * current version when there is one.
 */
export function SnapshotDialog({
  runId,
  reference,
  onOpenCurrent,
  onClose,
}: {
  runId: string;
  reference: RunReferenceView;
  onOpenCurrent: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const current = useReferences().byId.get(reference.id);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .runReference(runId, reference.id)
      .then((snapshot) => {
        if (alive) setContent(snapshot.content);
      })
      .catch((e: unknown) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [runId, reference.id]);

  const edited = current !== undefined && current.revision !== reference.revision;
  return (
    <Dialog title="Reference as sent" className="wide reference-dialog" onClose={onClose}>
      <DialogHeader
        title={`@${reference.name}`}
        subtitle={`As sent with this message · ${referenceSize(reference.size)}`}
        onClose={onClose}
      />
      {current === undefined ? (
        <p className="note">
          Deleted since this message was sent. This copy is what the agent was given.
        </p>
      ) : (
        edited && (
          <p className="note">Edited since this message was sent. The current version differs.</p>
        )
      )}
      {content === null ? (
        error === null ? (
          <p className="loading" role="status">
            Loading the copy that was sent
          </p>
        ) : (
          <p className="error" role="alert">
            {error}
          </p>
        )
      ) : (
        <pre className="reference-snapshot">{content}</pre>
      )}
      <div className="dialog-actions">
        {current !== undefined && (
          <button onClick={() => onOpenCurrent(current.id)}>
            {edited ? 'Open current version' : 'Edit reference'}
          </button>
        )}
        <button className="primary" data-dialog-focus onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
