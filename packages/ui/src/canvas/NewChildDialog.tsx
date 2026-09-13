import { type JSX, useEffect, useRef, useState } from 'react';
import { useEscape } from '../useEscape.ts';
import type { ChildPreviewView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';

/** Name the experiment and disclose its two sources before creation. */
export function NewChildDialog({
  parentName,
  parentId,
  onSelectSource,
  onCancel,
  onCreate,
}: {
  parentName: string;
  parentId: string;
  onSelectSource: (id: string) => void;
  onCancel: () => void;
  onCreate: (
    name: string,
    description: string,
    successCriteria: string,
    verificationHint: string,
    sourceVersion: string,
  ) => Promise<void>;
}): JSX.Element {
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [verificationHint, setVerificationHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ChildPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const submitting = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  useEffect(() => {
    let alive = true;
    setPreview(null);
    setPreviewError(null);
    void api
      .childPreview(parentId)
      .then((value) => {
        if (alive) setPreview(value);
      })
      .catch((e: unknown) => {
        if (alive) setPreviewError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [parentId, retry]);
  const cancel = (): void => {
    if (!submitting.current) onCancel();
  };
  useEscape(cancel);

  const submit = async (): Promise<void> => {
    if (submitting.current || name.trim() === '' || description.trim() === '' || preview === null)
      return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate(
        name.trim(),
        description.trim(),
        successCriteria.trim(),
        verificationHint.trim(),
        preview.sourceVersion,
      );
    } catch (e) {
      setError(describeError(e));
      setRetry((n) => n + 1);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    // Clicking the backdrop cancels; clicks inside must not fall through to it.
    <div className="dialog-backdrop" onClick={cancel}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Branch experiment"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3>Branch experiment from {parentName}</h3>
          <button className="dialog-close" onClick={cancel} aria-label="close">
            ×
          </button>
        </header>

        <label className="stacked">
          Experiment name
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="experiment name"
            placeholder="For example: Argparse approach"
            disabled={busy}
          />
        </label>
        <label className="stacked">
          Request
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe an experiment or ask a question."
            disabled={busy}
            aria-label="what should change"
            rows={3}
            onKeyDown={(e) => {
              // Enter creates. A description is one line more often than not, and
              // reaching for the mouse to start a run is the friction this whole
              // change is about. Shift+Enter still adds a line.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <p className="hint">
          Bonsai records whether files changed after the run. A question does not enforce read-only
          access.
        </p>
        <label className="stacked">
          Success looks like… (optional)
          <input
            value={successCriteria}
            onChange={(e) => setSuccessCriteria(e.target.value)}
            placeholder="the /search endpoint answers in under 100ms"
            aria-label="success criteria"
          />
        </label>
        <section className="creation-sources" aria-label="Experiment sources">
          <h4>Starts from</h4>
          {preview === null ? (
            previewError === null ? (
              <p role="status">Loading code and conversation sources…</p>
            ) : (
              <p className="error" role="alert">
                {previewError} <button onClick={() => setRetry((n) => n + 1)}>Retry sources</button>
              </p>
            )
          ) : (
            <>
              <p>
                Conversation:{' '}
                <button
                  className="linkish"
                  disabled={busy}
                  onClick={() => {
                    onCancel();
                    onSelectSource(preview.lineage.conversationFrom!.id);
                  }}
                >
                  {preview.lineage.conversationFrom?.displayName}
                </button>
              </p>
              <p>
                Code snapshot:{' '}
                <button
                  className="linkish"
                  disabled={busy}
                  onClick={() => {
                    onCancel();
                    onSelectSource(preview.lineage.codeFrom!.id);
                  }}
                >
                  {preview.lineage.codeFrom?.displayName}
                </button>
              </p>
              <p className="hint">{preview.codeNote}</p>
              <p className="hint">{preview.conversationNote}</p>
              {preview.parentActive && (
                <p className="note">
                  The source experiment is still active. A new commit before creation can change the
                  code snapshot; conversation can grow until the first run starts.
                </p>
              )}
            </>
          )}
        </section>

        <details className="disclosure">
          <summary>How should the agent check it? (optional)</summary>
          <label className="stacked">
            Verification instructions
            <textarea
              value={verificationHint}
              onChange={(e) => setVerificationHint(e.target.value)}
              placeholder="pytest tests/test_search.py"
              aria-label="verification hint"
              rows={2}
            />
          </label>
          <p className="hint">The agent runs the check and records what happened.</p>
        </details>

        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <span className="hint">Esc to cancel</span>
          <button onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || name.trim() === '' || description.trim() === '' || preview === null}
          >
            {busy ? 'Creating…' : 'Create and run'}
          </button>
        </div>
      </div>
    </div>
  );
}
