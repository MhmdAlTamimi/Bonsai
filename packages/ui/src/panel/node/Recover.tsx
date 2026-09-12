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
          ? 'Nothing was written — this node only reads. Resume asks the agent to carry on; keep unflags the node.'
          : 'Whatever the run had written is still in place. Resume tells the agent what actually landed and asks it to finish; discard throws those changes away; keep leaves them alone and unflags the node.'}
      </p>
      <div className="row">
        <button disabled={busy} onClick={() => onRecover('resume')}>
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
