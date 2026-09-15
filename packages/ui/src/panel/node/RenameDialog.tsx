import { useRef, useState, type JSX } from 'react';
import type { NodeView } from '@bonsai/shared';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { Dialog } from '../../Dialog.tsx';

export function RenameDialog({
  node,
  onClose,
  onChanged,
}: {
  node: NodeView;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const [name, setName] = useState(node.displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const close = (): void => {
    if (!saving.current) onClose();
  };

  const save = async (): Promise<void> => {
    if (saving.current || name.trim() === '') return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.updateNode(node.id, { displayName: name.trim() });
      onChanged();
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog title="Rename experiment" onClose={close} returnFocus='[aria-label="More actions"]'>
      <h3>Rename experiment</h3>
      <p className="hint">
        Changes the map label only. Code, history and conversation stay the same.
      </p>
      <label className="stacked">
        Experiment name
        <input
          data-dialog-focus
          value={name}
          disabled={busy}
          aria-label="experiment name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
        />
      </label>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || name.trim() === ''}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save name'}
        </button>
      </div>
    </Dialog>
  );
}
