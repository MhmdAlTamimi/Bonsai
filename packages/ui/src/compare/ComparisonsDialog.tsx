import type { JSX } from 'react';
import type { ComparisonSummary } from '@bonsai/shared';

import { Dialog } from '../Dialog.tsx';
import { Icon } from '../Icon.tsx';
import { exactTime, relativeTime } from '../panel/chat/time.ts';
import { compareTone } from '../state/compare.ts';

/** The project's comparisons, to reopen one. New ones are started from the map. */
export function ComparisonsDialog({
  projectName,
  list,
  onOpen,
  onClose,
}: {
  projectName: string;
  list: readonly ComparisonSummary[];
  onOpen: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <Dialog title="Comparisons" className="wide reference-dialog" onClose={onClose}>
      <header>
        <div>
          <h3>Comparisons</h3>
          <p className="hint">
            {projectName} · start one from the map: <Icon name="compare" /> Compare, then pick 2 to
            4 experiments
          </p>
        </div>
        <button className="dialog-close" aria-label="Close comparisons" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {list.length === 0 ? (
        <p className="muted reference-empty">No comparisons yet.</p>
      ) : (
        <ul className="reference-list" aria-label="Comparisons">
          {list.map((comparison, index) => (
            <li key={comparison.id}>
              <button
                className="reference-row"
                data-dialog-focus={index === 0 ? true : undefined}
                onClick={() => onOpen(comparison.id)}
              >
                <span className="reference-name comparison-title">{comparison.title}</span>
                <span className="reference-meta">
                  {comparison.running
                    ? 'Answering…'
                    : `${comparison.questions} question${comparison.questions === 1 ? '' : 's'}`}{' '}
                  ·{' '}
                  <time title={exactTime(comparison.updatedAt)}>
                    {relativeTime(comparison.updatedAt)}
                  </time>
                </span>
                <span className="reference-preview comparison-names">
                  {comparison.experiments.map((experiment, position) => (
                    <span key={position} className={`compare-name ${compareTone(position)}`}>
                      {experiment.name}
                      {experiment.nodeId === null ? ' (deleted)' : ''}
                    </span>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
