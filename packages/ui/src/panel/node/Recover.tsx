import type { JSX } from 'react';
import type { RecoverAction, RunView } from '@bonsai/shared';

/**
 * §6.6: the one state that must interrupt you, because it needs a decision.
 */
export function Recover({
  runs,
  isYourFolder,
  busy,
  onRecover,
}: {
  runs: readonly RunView[];
  isYourFolder: boolean;
  busy: boolean;
  onRecover: (action: RecoverAction) => void;
}): JSX.Element {
  return (
    <div className="recover">
      <p className="error">{runs.at(-1)?.error ?? 'The run was killed or failed midway.'}</p>
      <p className="hint">
        {isYourFolder
          ? 'Nothing was written — this node only reads.'
          : 'What the run wrote is still in the folder.'}
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => onRecover('resume')}>
          Resume
        </button>
        {/* Not offered for the user's own folder: discard is a hard reset plus
            a clean, and there it would destroy work Bonsai never made. */}
        {!isYourFolder && (
          <button disabled={busy} onClick={() => onRecover('discard')}>
            Discard
          </button>
        )}
        <button disabled={busy} onClick={() => onRecover('keep')}>
          Keep
        </button>
      </div>
    </div>
  );
}
