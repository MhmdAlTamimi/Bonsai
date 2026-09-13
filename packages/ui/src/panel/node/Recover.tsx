import type { JSX } from 'react';
import type { NodeDetail, RecoverAction, RunView } from '@bonsai/shared';

/**
 * §6.6: the one state that must interrupt you, because it needs a decision.
 */
export function Recover({
  runs,
  partialWork,
  interrupted,
  isYourFolder,
  busy,
  onRecover,
}: {
  runs: readonly RunView[];
  partialWork: NodeDetail['partialWork'];
  interrupted: boolean;
  isYourFolder: boolean;
  busy: boolean;
  onRecover: (action: RecoverAction) => void;
}): JSX.Element {
  return (
    <div className="recover">
      <p className="error">
        {interrupted
          ? (runs.at(-1)?.error ?? 'The run stopped before finishing.')
          : 'Partial work kept — not committed'}
      </p>
      <p className="hint">
        {isYourFolder
          ? 'Nothing was written — this node only reads.'
          : 'Uncommitted changes remain in this experiment’s folder. Keeping them does not save a completed result. Resume continues from these files.'}
      </p>
      {!isYourFolder &&
        (partialWork === null ? (
          <p role="status">Loading partial changes…</p>
        ) : (
          <details className="partial-review">
            <summary>
              Review partial changes ({partialWork.changed.length} file
              {partialWork.changed.length === 1 ? '' : 's'})
            </summary>
            {partialWork.changed.length === 0 && <p>No uncommitted files remain.</p>}
            <ul>
              {partialWork.changed.map((path) => (
                <li key={path}>
                  {path}
                  {partialWork.untracked.includes(path) ? ' (new, untracked)' : ''}
                </li>
              ))}
            </ul>
            {partialWork.patch && <pre className="stream">{partialWork.patch}</pre>}
          </details>
        ))}
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => onRecover('resume')}>
          Resume run
        </button>
        {/* Not offered for the user's own folder: discard is a hard reset plus
            a clean, and there it would destroy work Bonsai never made. */}
        {!isYourFolder && (
          <button disabled={busy || partialWork === null} onClick={() => onRecover('discard')}>
            Discard partial changes…
          </button>
        )}
        <button disabled={busy} onClick={() => onRecover('keep')}>
          Keep partial work
        </button>
      </div>
    </div>
  );
}
