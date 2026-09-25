import type { JSX } from 'react';
import type { RunView } from '@bonsai/shared';

/**
 * How a run ended, in one line.
 *
 * Time, cost and model when it finished; what happened instead when it did not
 * (D45). What it CHANGED is deliberately not here -- that is what review is
 * for, and repeating it under every turn is the redundancy this panel was
 * rebuilt to remove.
 *
 * The latest finished run's line is pinned under the conversation rather than
 * under its last message (`label` names it there, since it has left the turn it
 * belongs to). Where the agent is still working, the same place shows what it
 * is doing instead.
 */
export function RunFoot({ run, label }: { run: RunView; label?: string }): JSX.Element | null {
  if (run.status === 'running') return null;

  if (run.status === 'failed' || run.status === 'cancelled') {
    const said =
      run.endReason === 'app_closed'
        ? 'Bonsai closed while this run was working'
        : run.endReason === 'stopped'
          ? 'You stopped this run'
          : 'Failed';
    return (
      <p className="run-foot failed">
        {said}
        {run.error !== null ? ` — ${run.error}` : ''}
      </p>
    );
  }

  const parts = [
    run.durationMs === null ? null : duration(run.durationMs),
    run.costUsd > 0 ? `$${run.costUsd.toFixed(2)}` : null,
    run.model,
  ].filter((part): part is string => part !== null && part !== '');
  if (parts.length === 0) return null;

  return (
    <p className={`run-foot${label === undefined ? '' : ' pinned'}`}>
      {label !== undefined && <span className="run-foot-label">{label}</span>}
      {parts.map((part, i) => (
        <span key={part}>
          {(i > 0 || label !== undefined) && <span className="sep">·</span>}
          {part}
        </span>
      ))}
    </p>
  );
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
