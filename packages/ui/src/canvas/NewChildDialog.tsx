import { useCanRun } from '../state/RunAvailability.ts';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import { Dialog, DialogHeader } from '../Dialog.tsx';
import { ErrorNote } from '../ErrorNote.tsx';
import type { ChildPreviewView } from '@bonsai/shared';
import { NextRunInfo } from '../panel/NextRunInfo.tsx';
import { Icon } from '../Icon.tsx';
import { CreationSourceInfo } from './CreationSourceInfo.tsx';
import { SegmentedControl } from '../SegmentedControl.tsx';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import type { NewChild } from '../state/useChildCreation.ts';

/** Name the experiment and disclose its two sources before creation. */
export function NewChildDialog({
  parentId,
  redo,
  onCancel,
  onCreate,
}: {
  parentId: string;
  /** Redoing an experiment that is behind: the request is prefilled, and its work goes to the first run. */
  redo?: { id: string; name: string };
  onCancel: () => void;
  onCreate: (child: NewChild) => Promise<void>;
}): JSX.Element {
  const [description, setDescription] = useState(
    redo === undefined
      ? ''
      : `Redo the change from @${redo.name} on this code. Read what it did, then make the same change here.`,
  );
  const [name, setName] = useState(redo === undefined ? '' : `${redo.name} (latest)`);
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
    <Dialog title="Create child" className="create-child-dialog" onClose={cancel}>
      <DialogHeader
        title={
          <span className="creation-title">
            Create child
            <CreationSourceInfo preview={preview} startFresh={startFresh} />
          </span>
        }
        onClose={cancel}
        closeDisabled={busy}
      />
      <div className="creation-body">
        <div className="creation-fields">
          <label className="stacked">
            <FieldHeading number={1}>Experiment name</FieldHeading>
            <input
              ref={nameRef}
              data-dialog-focus
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="experiment name"
              placeholder="e.g. Faster search"
              disabled={busy}
            />
          </label>
          <label className="stacked">
            <FieldHeading number={2}>What should change?</FieldHeading>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the change to try, or ask a question"
              disabled={busy}
              aria-label="what should change"
              rows={redo === undefined ? 3 : 4}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.shiftKey &&
                  !event.altKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  if (!event.repeat) void submit();
                }
              }}
            />
          </label>
          {redo !== undefined && (
            <p className="hint">
              Starting now gives the agent {redo.name}&rsquo;s conversation, changes and notes to
              read. {redo.name} itself stays as it is.
            </p>
          )}
          <label className="stacked">
            <FieldHeading number={3} optional>
              What to test for?
            </FieldHeading>
            <textarea
              value={verificationHint}
              disabled={busy}
              onChange={(e) => setVerificationHint(e.target.value)}
              placeholder="e.g. Run search tests and measure response time"
              aria-label="verification hint"
              rows={2}
            />
          </label>
          <label className="stacked">
            <FieldHeading number={4} optional>
              What should the output look like?
            </FieldHeading>
            <textarea
              value={successCriteria}
              disabled={busy}
              onChange={(e) => setSuccessCriteria(e.target.value)}
              placeholder="e.g. Search responds in under 100 ms"
              aria-label="success criteria"
              rows={2}
            />
          </label>
        </div>
        {preview === null ? (
          previewError === null ? (
            <p className="loading" role="status">
              Loading run settings
            </p>
          ) : (
            <ErrorNote onRetry={() => setRetry((n) => n + 1)} retryLabel="Retry sources">
              {previewError}
            </ErrorNote>
          )
        ) : (
          <div className="creation-options">
            {preview.lineage.conversationFrom !== null && (
              <div className="start-fresh">
                <span className="creation-option-label">Conversation</span>
                <SegmentedControl
                  className="conversation-switch"
                  label="Conversation source"
                  selectedIndex={startFresh ? 1 : 0}
                >
                  <button
                    aria-pressed={!startFresh}
                    disabled={busy}
                    onClick={() => setStartFresh(false)}
                  >
                    Copy conversation
                  </button>
                  <button
                    aria-pressed={startFresh}
                    disabled={busy}
                    onClick={() => setStartFresh(true)}
                  >
                    Start fresh
                  </button>
                </SegmentedControl>
              </div>
            )}
            {preview.parentActive && <p className="note">Source still running · may change</p>}
            <NextRunInfo value={preview.nextRunSettings} setup={preview.setup} />
          </div>
        )}
        {error !== null && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-actions creation-actions">
        <span className="hint creation-shortcut">Ctrl / ⌘ + Enter to start</span>
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
          aria-label={canRun ? 'Start' : 'Reconnect to start'}
          aria-busy={busy}
        >
          <Icon name="play" />
          {canRun ? 'Start' : 'Reconnect to start'}
        </button>
      </div>
    </Dialog>
  );
}

function FieldHeading({
  number,
  optional = false,
  children,
}: {
  number: number;
  optional?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className="creation-field-heading">
      <span className="creation-field-number" aria-hidden="true">
        {number}
      </span>
      <span>{children}</span>
      {optional && <span className="creation-field-optional">Optional</span>}
    </span>
  );
}
