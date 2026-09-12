import { type JSX, useEffect, useRef, useState } from 'react';
import { useEscape } from '../useEscape.ts';

/**
 * Name and change description for a new child, raised where you dropped it.
 *
 * D5: making a change means explicitly creating a child, with a name, a
 * description and a confirmation. That was buried in a panel disclosure; here
 * it is the end of the gesture that created the node, so the two are one action.
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
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [successCriteria, setSuccessCriteria] = useState('');
  const [verificationHint, setVerificationHint] = useState('');
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEscape(onCancel);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await onCreate(
        name.trim() || 'untitled',
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

        <input
          ref={nameRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          aria-label="child name"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="what should change? start with ? to just ask"
          aria-label="child description"
          rows={4}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />

        {/*
         * Behind a disclosure on purpose.
         *
         * These two answers are the point of the whole feature, and putting
         * them in the flow as two more required-looking boxes is how
         * enthusiasm dies -- there is already friction here, since a name and
         * a description are both wanted before anything happens. Closed by
         * default, one click to open, and creating without them behaves
         * exactly as it did before they existed.
         */}
        <details className="disclosure">
          <summary>What would make this a success? (optional)</summary>
          <label className="stacked">
            What should be true when this works?
            <textarea
              value={successCriteria}
              onChange={(e) => setSuccessCriteria(e.target.value)}
              placeholder="the /search endpoint returns results in under 100ms"
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
          <p className="hint">
            Sent with every run on this node. The agent runs the check and writes what happened into
            CONTEXT.md, so you can compare approaches on evidence rather than on prose.
          </p>
        </details>

        <div className="dialog-actions">
          <span className="hint">Esc to cancel</span>
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? 'Creating…' : 'Create and run'}
          </button>
        </div>

        <p className="hint">
          It forks this node's whole conversation, and branches from the nearest ancestor that has a
          commit.
        </p>
      </div>
    </div>
  );
}
