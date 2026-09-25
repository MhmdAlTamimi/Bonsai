import { useCanRun } from '../state/RunAvailability.ts';
import { type JSX, useEffect, useRef, useState } from 'react';
import { Dialog } from '../Dialog.tsx';
import type { ChildPreviewView } from '@bonsai/shared';
import { NextRunInfo } from '../panel/NextRunInfo.tsx';
import { Icon } from '../Icon.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import type { NewChild } from '../state/useChildCreation.ts';

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
  onCreate: (child: NewChild) => Promise<void>;
}): JSX.Element {
  const [description, setDescription] = useState('');
  const [name, setName] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [verificationHint, setVerificationHint] = useState('');
  const [startFresh, setStartFresh] = useState(false);
  const canRun = useCanRun();
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
  const select = (id: string): void => {
    onCancel();
    onSelectSource(id);
  };

  const submit = async (startNow = true): Promise<void> => {
    if (
      (startNow && !canRun) ||
      submitting.current ||
      name.trim() === '' ||
      (startNow && description.trim() === '') ||
      preview === null
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        successCriteria: successCriteria.trim(),
        verificationHint: verificationHint.trim(),
        sourceVersion: preview.sourceVersion,
        startNow,
        // Only meaningful when there is a conversation to leave behind.
        startFresh: startFresh && preview.lineage.conversationFrom !== null,
      });
    } catch (e) {
      setError(describeError(e));
      setRetry((n) => n + 1);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog title="Branch experiment" onClose={cancel}>
      <header>
        <h3>Branch experiment from {parentName}</h3>
        <button className="dialog-close" onClick={cancel} aria-label="close">
          <Icon name="close" />
        </button>
      </header>

      <label className="stacked">
        Experiment name
        <input
          ref={nameRef}
          data-dialog-focus
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="experiment name"
          placeholder="For example: Argparse approach"
          disabled={busy}
        />
      </label>
      <label className="stacked">
        Request (optional for later)
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
            <div className="source-pair">
              <SourceRow
                label="Conversation"
                source={startFresh ? null : preview.lineage.conversationFrom}
                empty={
                  preview.lineage.conversationFrom === null ? 'None yet' : 'None · starts fresh'
                }
                badge="Copied now"
                disabled={busy}
                onSelect={select}
              />
              <SourceRow
                label="Code"
                source={preview.lineage.codeFrom}
                empty="Unavailable"
                badge="Committed"
                disabled={busy}
                onSelect={select}
              />
            </div>
            {preview.lineage.conversationFrom !== null && (
              <label className="check start-fresh">
                <input
                  type="checkbox"
                  checked={startFresh}
                  onChange={(e) => setStartFresh(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  <strong>Start fresh</strong> — leaves out the parent&rsquo;s conversation. Code
                  changes are still inherited.
                </span>
              </label>
            )}
            {preview.parentActive && <p className="note">Source still running · may change</p>}
            <details className="source-details">
              <summary>Source details</summary>
              <p>{preview.codeNote}</p>
              <p>{preview.conversationNote}</p>
            </details>
          </>
        )}
      </section>

      {preview?.nextRunSettings && <NextRunInfo value={preview.nextRunSettings} />}
      {preview?.setup && (preview.setup.copyFiles.length > 0 || preview.setup.setupCommand) && (
        <details className="creation-setup">
          <summary>Experiment setup</summary>
          {preview.setup.copyFiles.length > 0 && <p>Copy: {preview.setup.copyFiles.join(', ')}</p>}
          {preview.setup.setupCommand && <pre>{preview.setup.setupCommand}</pre>}
        </details>
      )}
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
      <div className="dialog-actions creation-actions">
        <span className="hint">Enter in request to run · Shift+Enter for a new line</span>
        <button className="creation-cancel" onClick={cancel} disabled={busy}>
          Cancel
        </button>
        <button
          className="creation-secondary"
          title="Create without starting a run"
          disabled={busy || name.trim() === '' || preview === null}
          onClick={() => void submit(false)}
        >
          <Icon name="plus" /> Save for later
        </button>
        <button
          className="primary"
          onClick={() => void submit()}
          disabled={
            !canRun || busy || name.trim() === '' || description.trim() === '' || preview === null
          }
        >
          <Icon name="play" />
          {busy ? 'Creating…' : canRun ? 'Start experiment' : 'Reconnect agent to run'}
        </button>
      </div>
    </Dialog>
  );
}

/** One inherited source: what it is, where it comes from, and when it was taken. */
function SourceRow({
  label,
  source,
  empty,
  badge,
  disabled,
  onSelect,
}: {
  label: string;
  source: { id: string; displayName: string } | null;
  /** What to say when nothing is inherited. */
  empty: string;
  badge: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <div className="source-row">
      <span className="source-kind">{label}</span>
      {source === null ? (
        <span className="source-name muted">{empty}</span>
      ) : (
        <button
          className="linkish source-name"
          disabled={disabled}
          title={source.displayName}
          onClick={() => onSelect(source.id)}
        >
          {source.displayName}
        </button>
      )}
      {source !== null && <span className="source-badge">{badge}</span>}
    </div>
  );
}
