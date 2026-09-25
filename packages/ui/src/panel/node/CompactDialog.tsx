import { useRef, useState, type JSX } from 'react';
import type { NodeView } from '@bonsai/shared';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { Dialog } from '../../Dialog.tsx';
import { cardMenuButton } from '../../canvas/cardActions.ts';

/** `/compact`, with room to say what the summary should keep. */
export function CompactDialog({
  node,
  onClose,
  onStarted,
}: {
  node: NodeView;
  onClose: () => void;
  onStarted: (nodeId: string) => void;
}): JSX.Element {
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const starting = useRef(false);
  const close = (): void => {
    if (!starting.current) onClose();
  };

  const start = async (): Promise<void> => {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.compact(node.id, focus.trim() === '' ? undefined : focus.trim());
      onStarted(node.id);
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      starting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Compact conversation"
      onClose={close}
      returnFocus={cardMenuButton(node.displayName)}
    >
      <h3>Compact {node.displayName}</h3>
      <p className="hint">
        Summarises older turns so the agent has room to work. Experiments branched afterwards start
        from the summary.
      </p>
      <label className="stacked">
        Keep in focus (optional)
        <input
          data-dialog-focus
          value={focus}
          disabled={busy}
          aria-label="keep in focus"
          placeholder="the test results and the approach we chose"
          onChange={(e) => setFocus(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start();
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
        <button className="primary" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Compact'}
        </button>
      </div>
    </Dialog>
  );
}
