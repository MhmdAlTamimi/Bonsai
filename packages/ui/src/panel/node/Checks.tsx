import type { JSX } from 'react';
import type { NodeDetail, NodeView } from '@bonsai/shared';
import { Markdown } from '../chat/Markdown.tsx';

/** Goals and attributed evidence, without inventing a pass/fail verdict. */
export function Checks({
  node,
  detail,
}: {
  node: NodeView;
  detail: NodeDetail | null;
}): JSX.Element | null {
  if (detail === null) return null;
  const latest = detail.runs.at(-1);
  const source = detail.testingSource;
  const current = source !== null && !source.inherited && !source.predatesLatestRun;
  return (
    <section className="checks results-checks" aria-label="Goal and recorded checks">
      <h3>Goal</h3>
      <p>{detail.successCriteria ?? 'No success criteria were provided.'}</p>
      {detail.verificationHint !== null && (
        <details className="disclosure">
          <summary>Requested verification</summary>
          <p>{detail.verificationHint}</p>
        </details>
      )}
      <h3>Recorded checks</h3>
      {!current && (
        <p className="hint">
          {node.status === 'running' || node.status === 'needs_you'
            ? 'The run is still in progress. No completed checks recorded for this run.'
            : 'No checks recorded for the latest run.'}
        </p>
      )}
      {detail.testingNotes !== null && (
        <>
          <p className="evidence-source">
            {source === null
              ? 'Existing testing notes — source not recorded.'
              : `${source.inherited ? 'Inherited from' : 'Recorded by'} ${source.nodeName}, run ${source.runId.slice(0, 8)} (${source.recordedAt}).`}
          </p>
          {source?.predatesLatestRun === true && (
            <p className="hint">These notes predate the latest run.</p>
          )}
          <div className="testing-notes">
            <Markdown source={detail.testingNotes} />
          </div>
        </>
      )}
      <p className="hint">
        {detail.testingNotes === null
          ? 'There is no recorded testing evidence here. A finished run does not establish that the experiment worked.'
          : 'These are recorded notes, not an independent verification or a pass/fail verdict.'}
      </p>
      {(detail.partialWork?.changed.length ?? 0) > 0 && (
        <p className="note">Uncommitted changes are not covered by these notes.</p>
      )}
      {latest?.status === 'failed' && (
        <p className="note">
          The latest run failed. Inspect its conversation and partial work before judging the
          result.
        </p>
      )}
    </section>
  );
}
