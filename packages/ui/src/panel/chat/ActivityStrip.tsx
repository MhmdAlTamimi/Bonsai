import { type JSX, useEffect, useState } from 'react';
import type { NodeView, RunActivity } from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';
import { Icon } from '../../Icon.tsx';
import { describeTool, since, waitingHeadline } from './activity.ts';

/**
 * What the run is doing right now, above the composer (D43).
 *
 * "Agent working…" was the whole of it, which made a twenty-minute `uv sync`
 * look exactly like a hung agent, and a run waiting for its own background
 * job look like a finished one. Now the command and how long it has taken are
 * shown, and a run that is waiting says what for and offers the way to end it.
 */
export function ActivityStrip({
  node,
  activity,
  onError,
}: {
  node: NodeView;
  activity: RunActivity | null;
  onError: (message: string | null) => void;
}): JSX.Element | null {
  const now = useNow(node.status === 'running' && activity !== null);
  const [finishing, setFinishing] = useState(false);
  useEffect(() => {
    if (activity?.state !== 'waiting') setFinishing(false);
  }, [activity?.state]);

  if (node.status !== 'running') return null;
  if (node.queuePosition !== null) {
    return (
      <p className="activity" role="status">
        Queued · position {node.queuePosition}
      </p>
    );
  }

  if (activity?.state === 'waiting') {
    const finish = (): void => {
      setFinishing(true);
      onError(null);
      void api.finishNow(node.id).catch((e: unknown) => {
        setFinishing(false);
        onError(describeError(e));
      });
    };
    return (
      <section className="activity activity-waiting" aria-label="Background work">
        <p className="activity-line">
          <Icon name="clock" />
          <span role="status">{waitingHeadline(activity.background)}</span>
        </p>
        <ul className="activity-jobs">
          {activity.background.map((job) => (
            <li key={job.id}>
              <code title={job.description}>{job.description}</code>
              <span className="activity-meta" aria-hidden="true">
                {since(job.startedAt, now)}
              </span>
              {!job.tracked && (
                <span
                  className="chip tiny"
                  title="Started outside the agent’s background mode (for example with nohup). Bonsai found it and is waiting for it, but the agent is only told when it ends because Bonsai tells it."
                >
                  detached
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="activity-actions">
          <p className="hint">
            The run ends, and its results are saved, when this work does. Finish now stops it and
            saves what is there.
          </p>
          <button onClick={finish} disabled={finishing}>
            {finishing ? 'Finishing…' : 'Finish now'}
          </button>
        </div>
      </section>
    );
  }

  const tool = activity?.tool ?? null;
  return (
    <p className="activity activity-line">
      <span role="status">{tool === null ? 'Agent working…' : describeTool(tool)}</span>
      {tool !== null && (
        <span className="activity-meta" aria-hidden="true">
          {since(tool.startedAt, now)}
        </span>
      )}
    </p>
  );
}

/** The time, once a second while `active`, so elapsed times count up. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
