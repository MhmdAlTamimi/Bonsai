import { useEffect, useState, type JSX } from 'react';
import type { NodeView } from '@bonsai/shared';
import { api, type NodeDiffView } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { Diff } from '../chat/Diff.tsx';

export function ExperimentChanges({
  node,
  revision,
}: {
  node: NodeView;
  revision: string;
}): JSX.Element {
  const [data, setData] = useState<NodeDiffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void api
      .diff(node.id)
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((e: unknown) => {
        if (alive) setError(describeError(e));
      });
    return () => {
      alive = false;
    };
  }, [node.id, node.status, revision, retry]);
  return (
    <section className="experiment-changes" aria-label="All changes in this experiment">
      <div className="results-heading">
        <h3>All changes in this experiment</h3>
        <button className="linkish" onClick={() => setRetry((n) => n + 1)}>
          Refresh changes
        </button>
      </div>
      <p className="hint">
        The combined committed result across all runs, compared with the starting code snapshot.
      </p>
      {data !== null ? (
        <>
          <p className="comparison-base">Compared with: {data.baseLabel}</p>
          <Diff patch={data.patch} dirty={data.dirty} />
        </>
      ) : error === null ? (
        <p role="status">Loading experiment changes…</p>
      ) : (
        <p className="error" role="alert">
          {error} <button onClick={() => setRetry((n) => n + 1)}>Retry experiment changes</button>
        </p>
      )}
    </section>
  );
}
