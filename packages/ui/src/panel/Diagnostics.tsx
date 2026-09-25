import { useState, type JSX } from 'react';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { CopyButton } from '../CopyButton.tsx';

export function Diagnostics({ nodeId }: { nodeId: string | null }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gather = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setText(null);
    try {
      setText(JSON.stringify(await api.diagnostics(nodeId), null, 2));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="diagnostics">
      <h4>Diagnostics report</h4>
      <p className="hint">
        Versions, local paths, counts, run metadata and filtered log events. Names and error text
        are omitted; known credential patterns are redacted. Review before sharing.
      </p>
      <button disabled={busy} aria-busy={busy} onClick={() => void gather()}>
        Generate report
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {text !== null && (
        <>
          <textarea
            readOnly
            aria-label="Diagnostics preview"
            value={text}
            rows={12}
            spellCheck={false}
          />
          <div className="save-row">
            <CopyButton text={text} label="Copy report" />
          </div>
        </>
      )}
    </section>
  );
}
