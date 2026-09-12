import { type JSX, useCallback, useState } from 'react';

import { useEscape } from './useEscape.ts';

/**
 * Confirmation, in the app rather than in the browser chrome.
 *
 * Both destructive flows used `window.confirm()`: an unstyled native modal,
 * with the app's own dialog system sitting unused a few files away. It is the
 * one moment the interface most needs to look like it knows what it is doing,
 * and it was the one moment it stopped looking like itself. The native dialog
 * also cannot carry structure -- deleting a project has several paragraphs to
 * say about what survives on disk, and they arrived as one run-on block.
 *
 * `requireText` exists for the same reason GitHub asks you to type a repository
 * name: deleting a project destroys paid, unreproducible work and cascades to
 * every descendant, and a button you can hit by reflex is not consent.
 *
 * Promise-shaped so call sites read the way `window.confirm` did -- ask, then
 * carry on or return -- which keeps the flows it replaces readable.
 */
export interface ConfirmRequest {
  title: string;
  /** Paragraphs. Split rather than one string, because these get long. */
  body: string[];
  confirmLabel: string;
  danger?: boolean;
  /** When set, the exact text the user has to type before confirming. */
  requireText?: string;
}

export function useConfirm(): {
  ask: (request: ConfirmRequest) => Promise<boolean>;
  /** Render this wherever the hook is used; null when nothing is being asked. */
  dialog: JSX.Element | null;
} {
  const [pending, setPending] = useState<{
    request: ConfirmRequest;
    settle: (ok: boolean) => void;
  } | null>(null);

  const ask = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setPending({
          request,
          settle: (ok) => {
            setPending(null);
            resolve(ok);
          },
        });
      }),
    [],
  );

  return {
    ask,
    dialog:
      pending === null ? null : (
        <Confirm
          request={pending.request}
          onAnswer={pending.settle}
          // Remount per request so a typed confirmation cannot survive into the
          // next one.
          key={pending.request.title}
        />
      ),
  };
}

function Confirm({
  request,
  onAnswer,
}: {
  request: ConfirmRequest;
  onAnswer: (ok: boolean) => void;
}): JSX.Element {
  const [typed, setTyped] = useState('');
  const cancel = useCallback(() => onAnswer(false), [onAnswer]);
  useEscape(cancel);

  const locked = request.requireText !== undefined && typed.trim() !== request.requireText;

  return (
    <div className="dialog-backdrop" onClick={cancel}>
      <div
        className="dialog confirm"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3>{request.title}</h3>
        </header>
        {request.body.map((paragraph, i) => (
          <p key={i} className="confirm-body">
            {paragraph}
          </p>
        ))}
        {request.requireText !== undefined && (
          <label className="stacked">
            <span>
              Type <strong>{request.requireText}</strong> to confirm
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="confirmation"
              spellCheck={false}
              autoFocus
            />
          </label>
        )}
        <div className="dialog-actions">
          {/* Cancel is focused first and sits where the eye lands. The
              destructive button should never be the one a stray Enter hits. */}
          <button onClick={cancel} autoFocus={request.requireText === undefined}>
            Cancel
          </button>
          <button
            className={request.danger === true ? 'destructive' : 'primary'}
            disabled={locked}
            onClick={() => onAnswer(true)}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
