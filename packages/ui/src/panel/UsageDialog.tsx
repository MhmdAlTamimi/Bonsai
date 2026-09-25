import { useEffect, useState, type JSX } from 'react';
import type { ProjectUsageView } from '@bonsai/shared';
import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import { Dialog, DialogHeader } from '../Dialog.tsx';
import { ErrorNote } from '../ErrorNote.tsx';
import { plural } from '../words.ts';

type UsageRun = ProjectUsageView['experiments'][number]['runs'][number];
const sum = (
  runs: readonly UsageRun[],
  field: 'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens',
): number => runs.reduce((n, run) => n + run[field], 0);
const money = (value: number): string => `$${value.toFixed(3)}`;
export function UsageDialog({
  projectId,
  projectName,
  revision,
  onClose,
  onSelect,
}: {
  projectId: string;
  projectName: string;
  revision: number;
  onClose: () => void;
  onSelect: (id: string) => void;
}): JSX.Element {
  const [data, setData] = useState<ProjectUsageView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    void api
      .usage(projectId)
      .then((result) => {
        if (alive) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(describeError(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, revision, retry]);
  const runs = data?.experiments.flatMap((experiment) => experiment.runs) ?? [];
  return (
    <Dialog title="Agent usage" className="wide usage-dialog" onClose={onClose}>
      <DialogHeader
        title="Agent usage"
        subtitle={`${projectName} · this project only`}
        onClose={onClose}
      />
      <p className="hint">
        Recorded API-equivalent estimates, not a bill or account balance. Subscription runs do not
        represent extra charges.
      </p>
      {loading && (
        <p className="loading" role="status">
          {data ? 'Updating usage' : 'Loading usage'}
        </p>
      )}
      {error && (
        <ErrorNote onRetry={() => setRetry((n) => n + 1)} retryLabel="Retry usage">
          {data && 'Showing previously loaded totals. '}
          {error}
        </ErrorNote>
      )}
      {data && (
        <>
          <div className="usage-totals">
            <div>
              <span>Estimated value</span>
              <strong>{money(sum(runs, 'costUsd'))}</strong>
            </div>
            <div>
              <span>Runs recorded</span>
              <strong>{runs.length}</strong>
            </div>
            <div>
              <span>Input tokens</span>
              <strong>{sum(runs, 'inputTokens').toLocaleString()}</strong>
            </div>
            <div>
              <span>Output tokens</span>
              <strong>{sum(runs, 'outputTokens').toLocaleString()}</strong>
            </div>
            <div>
              <span>Cache read</span>
              <strong>{sum(runs, 'cacheReadTokens').toLocaleString()}</strong>
            </div>
            <div>
              <span>Cache write</span>
              <strong>{sum(runs, 'cacheCreationTokens').toLocaleString()}</strong>
            </div>
          </div>
          {runs.length === 0 && <p>No runs recorded yet.</p>}
          {data.experiments.map((experiment) => (
            <details className="usage-experiment" key={experiment.id}>
              <summary>
                <span>{experiment.name}</span>
                <span>
                  {plural(experiment.runs.length, 'run')} · {money(sum(experiment.runs, 'costUsd'))}
                </span>
              </summary>
              <button
                className="linkish"
                onClick={() => {
                  onSelect(experiment.id);
                  onClose();
                }}
              >
                View experiment
              </button>
              {experiment.runs.length === 0 ? (
                <p className="hint">No runs yet.</p>
              ) : (
                <div className="usage-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Model / source</th>
                        <th>Input / output</th>
                        <th>Estimate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {experiment.runs.map((run, index) => (
                        <tr key={run.id}>
                          <td>
                            #{index + 1} · {run.status === 'done' ? 'Finished' : run.status}
                            <small>{new Date(run.startedAt).toLocaleString()}</small>
                          </td>
                          <td>
                            {run.model ?? 'Not recorded'}
                            <small>
                              {run.apiKeySource === 'none'
                                ? 'Subscription'
                                : run.apiKeySource === null || run.apiKeySource === 'unknown'
                                  ? 'Source not recorded'
                                  : 'API key'}
                            </small>
                          </td>
                          <td>
                            {run.inputTokens.toLocaleString()} / {run.outputTokens.toLocaleString()}
                          </td>
                          <td>{run.status === 'running' ? 'Pending' : money(run.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          ))}
        </>
      )}
      <p className="hint">
        Active run usage appears when recorded. Missing older model/source information stays marked
        as unrecorded.
      </p>
    </Dialog>
  );
}
