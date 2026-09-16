import type { JSX } from 'react';
import type { NodeDetail, NodeView, RecoverAction, RunView } from '@bonsai/shared';

import { Icon } from '../../Icon.tsx';
import { useCanRun } from '../../state/RunAvailability.ts';
import { recoveryWords } from './recoveryWords.ts';

/**
 * §6.6, worded by what happened (D45): the one state that must interrupt you,
 * because it needs a decision about files nobody has saved.
 */
export function Recovery({
  node,
  runs,
  partialWork,
  isYourFolder,
  busy,
  onRecover,
  onReview,
}: {
  node: NodeView;
  runs: readonly RunView[];
  partialWork: NodeDetail['partialWork'];
  isYourFolder: boolean;
  busy: boolean;
  onRecover: (action: RecoverAction) => void;
  /** Shows the uncommitted files in the Changes tab, where any of them can be opened. */
  onReview: () => void;
}): JSX.Element {
  const canRun = useCanRun();
  const changed = partialWork?.changed ?? [];
  const words = recoveryWords({
    runs,
    interrupted: node.status === 'interrupted',
    changedFiles: changed.length,
    isYourFolder,
  });
  const loading = !isYourFolder && partialWork === null;

  return (
    <section className="recover" aria-label="Uncommitted work">
      <p className="recover-headline">
        <Icon name="warning" />
        <span>{words.headline}</span>
      </p>
      {words.details.map((line) => (
        <p key={line} className="hint recover-detail">
          {line}
        </p>
      ))}
      {loading ? (
        <p role="status">Checking this experiment’s folder…</p>
      ) : changed.length === 0 ? (
        <p className="hint">{words.files}</p>
      ) : (
        // The files themselves are read in the Changes tab, one window each,
        // rather than as one long patch inside this notice.
        <p className="hint recover-files">
          {words.files}{' '}
          <button className="linkish" onClick={onReview}>
            Review {changed.length === 1 ? 'it' : 'them'}
          </button>
        </p>
      )}
      <div className="row">
        <button
          className="primary"
          disabled={busy || loading || !canRun}
          title={words.continueTitle}
          onClick={() => onRecover('resume')}
        >
          {words.continueLabel}
        </button>
        {words.leaveLabel !== null && (
          <button disabled={busy} onClick={() => onRecover('keep')}>
            {words.leaveLabel}
          </button>
        )}
        {/* Never for the user's own folder: discard is a hard reset plus a
            clean, and there it would destroy work Bonsai never made. */}
        {words.discardLabel !== null && (
          <button disabled={busy || loading} onClick={() => onRecover('discard')}>
            {words.discardLabel}
          </button>
        )}
      </div>
    </section>
  );
}
