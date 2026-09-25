import { type JSX, useState } from 'react';
import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import type { NodeDetail, NodeView } from '@bonsai/shared';
import { Markdown } from '../chat/Markdown.tsx';

/**
 * What this experiment was for.
 *
 * A property of the node rather than part of the conversation, so it is read
 * with the node's other facts and not between two messages.
 */
export function Goal({ detail }: { detail: NodeDetail | null }): JSX.Element | null {
  return detail === null ? null : <GoalForm key={detail.node.id} detail={detail} />;
}
function GoalForm({ detail }: { detail: NodeDetail }): JSX.Element {
  const [goal, setGoal] = useState(detail.successCriteria ?? '');
  const [test, setTest] = useState(detail.verificationHint ?? '');
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <section className="checks" aria-label="Goal">
      <h3>Goal and checks</h3>
      <label>
        Success looks like
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label>
        How to test
        <textarea value={test} onChange={(e) => setTest(e.target.value)} />
      </label>
      <p className="hint">Optional. Applies to the next run.</p>
      <button
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          setFeedback('');
          try {
            await api.updateNode(detail.node.id, { successCriteria: goal, verificationHint: test });
            setFeedback('Saved');
          } catch (e) {
            setFeedback(describeError(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        {saving ? 'Saving…' : 'Save goal and checks'}
      </button>
      <p role="status">{feedback}</p>
    </section>
  );
}

/** Attributed evidence, without inventing a pass/fail verdict. */
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
    <section className="checks results-checks" aria-label="Recorded checks">
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
