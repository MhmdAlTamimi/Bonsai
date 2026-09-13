import type { JSX } from 'react';
import type { NodeDetail, NodeView } from '@bonsai/shared';

/**
 * "Did it work?"
 *
 * Above the conversation, because it is the answer to the question the whole
 * node exists to settle, and the point of the product is the moment you
 * compare two of them.
 *
 * Deliberately the agent's own words, with no verdict extracted from them.
 * Whether "3 of 14 tests fail" counts as working is a judgement about your
 * project, and a green tick derived from prose would be a confident guess
 * dressed as a fact. Anything unclear is a chat away.
 */
export function Checks({
  node,
  detail,
}: {
  node: NodeView;
  detail: NodeDetail | null;
}): JSX.Element | null {
  if (detail === null) return null;
  if (detail.successCriteria == null && detail.testingNotes == null) return null;

  return (
    <section className="checks">
      <h3>Testing notes</h3>
      {detail.successCriteria != null && <p className="hint">Goal: {detail.successCriteria}</p>}
      {detail.testingNotes != null ? (
        <>
          <p className="hint">
            {detail.testingSource === null
              ? 'Existing testing notes — source not recorded. These are not verification of this run.'
              : `${detail.testingSource.inherited ? 'Inherited from' : 'Recorded by'} ${detail.testingSource.nodeName}, run ${detail.testingSource.runId.slice(0, 8)} (${detail.testingSource.recordedAt}).${detail.testingSource.predatesLatestRun ? ' These notes predate the latest run; no new checks are recorded here.' : ' Agent-reported evidence; not an independent verdict.'}`}
          </p>
          {(detail.partialWork?.changed.length ?? 0) > 0 && (
            <p className="hint">Uncommitted changes are not covered by these notes.</p>
          )}
          <pre className="stream">{detail.testingNotes}</pre>
        </>
      ) : (
        <p className="hint">
          {node.status === 'running'
            ? 'The run is still going.'
            : node.hasCommits
              ? 'No notes from the agent — ask it what it checked.'
              : 'Nothing committed here yet.'}
        </p>
      )}
    </section>
  );
}
