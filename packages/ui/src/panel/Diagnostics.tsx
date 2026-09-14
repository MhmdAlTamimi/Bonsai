import { useState, type JSX } from 'react';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

export function Diagnostics({ nodeId }: { nodeId: string | null }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState('');
  const gather = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setCopy('');
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
      <button disabled={busy} onClick={() => void gather()}>
        {busy ? 'Generating…' : 'Generate report'}
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
            <button
              disabled={busy}
              onClick={() => {
                void navigator.clipboard
                  .writeText(text)
                  .then(() => setCopy('Copied'))
                  .catch(() => setCopy('Copy failed. Select the report to copy manually.'));
              }}
            >
              Copy report
            </button>
            <span role="status">{copy}</span>
          </div>
        </>
      )}
    </section>
  );
}
