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
      <h3>Did it work?</h3>
      {detail.successCriteria != null && (
        <p className="hint">
          Success looks like: <em>{detail.successCriteria}</em>
        </p>
      )}
      {detail.testingNotes != null ? (
        <pre className="stream">{detail.testingNotes}</pre>
      ) : (
        <p className="hint">
          {node.status === 'running'
            ? 'The run is still going.'
            : node.hasCommits
              ? 'The agent left no testing notes for this run. Ask it what it checked.'
              : 'Nothing has been committed here yet, so there is nothing to check.'}
        </p>
      )}
    </section>
  );
}
