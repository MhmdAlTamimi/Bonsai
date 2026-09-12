import { type JSX, useEffect, useRef, useState } from 'react';
import { useEscape } from '../useEscape.ts';
import { deriveNodeName } from '@bonsai/shared';

/**
 * One question, asked where you dropped the node.
 *
 * It used to ask four: a name, a description, and — after phase 2 — what
 * success looks like and how to check it. Four fields between an idea and a
 * run is how a tool stops being used for the small experiments it exists for,
 * and the name was the worst of them: a decision with no payoff, made before
 * you know what the node will turn out to be.
 *
 * So there is one field. The name is derived from what you type and shown as
 * you type it, editable in one click for the times the guess is poor. Display
 * names are metadata and change freely (D3 constrains a node's code, not its
 * label), so a slightly-wrong derived name costs a rename while a required one
 * costs a decision every time.
 *
 * The two success questions stay behind a disclosure, closed. They are the
 * point of the product but they are not the point of THIS moment.
 */
export function NewChildDialog({
  parentName,
  onCancel,
  onCreate,
}: {
  parentName: string;
  onCancel: () => void;
  onCreate: (
    name: string,
    description: string,
    successCriteria: string,
    verificationHint: string,
  ) => Promise<void>;
}): JSX.Element {
  const [description, setDescription] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [successCriteria, setSuccessCriteria] = useState('');
  const [verificationHint, setVerificationHint] = useState('');
  const [busy, setBusy] = useState(false);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    descRef.current?.focus();
  }, []);
  useEscape(onCancel);

  // Shown live, so the derived name is a visible consequence of typing rather
  // than something that appears on the canvas afterwards and surprises you.
  const derived = deriveNodeName(description, '');
  const effective = name ?? derived;

  const submit = async (): Promise<void> => {
    if (busy || description.trim() === '') return;
    setBusy(true);
    try {
      await onCreate(
        effective,
        description.trim(),
        successCriteria.trim(),
        verificationHint.trim(),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    // Clicking the backdrop cancels; clicks inside must not fall through to it.
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Create a child node"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3>New child of {parentName}</h3>
          <button className="dialog-close" onClick={onCancel} aria-label="close">
            ×
          </button>
        </header>

        <textarea
          ref={descRef}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What should change? Start with ? to just ask."
          aria-label="what should change"
          rows={3}
          onKeyDown={(e) => {
            // Enter creates. A description is one line more often than not, and
            // reaching for the mouse to start a run is the friction this whole
            // change is about. Shift+Enter still adds a line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        <div className="named-as">
          {name === null ? (
            <>
              <span className="hint">
                Name: <strong>{derived === '' ? '—' : derived}</strong>
              </span>
              <button
                className="linkish"
                disabled={description.trim() === ''}
                onClick={() => {
                  setName(derived);
                  setTimeout(() => nameRef.current?.select(), 0);
                }}
              >
                rename
              </button>
            </>
          ) : (
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="node name"
              placeholder={derived}
            />
          )}
        </div>

        <details className="disclosure">
          <summary>What would make this a success? (optional)</summary>
          <label className="stacked">
            What should be true when this works?
            <textarea
              value={successCriteria}
              onChange={(e) => setSuccessCriteria(e.target.value)}
              placeholder="the /search endpoint answers in under 100ms"
              aria-label="success criteria"
              rows={2}
            />
          </label>
          <label className="stacked">
            How should the agent check it?
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

        <div className="dialog-actions">
          <span className="hint">Esc to cancel</span>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary"
            onClick={() => void submit()}
            disabled={busy || description.trim() === ''}
          >
            {busy ? 'Creating…' : 'Create and run'}
          </button>
        </div>
      </div>
    </div>
  );
}
