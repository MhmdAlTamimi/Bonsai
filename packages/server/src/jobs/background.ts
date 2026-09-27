import type { BackgroundJob, RunActivity } from '@bonsai/shared';

import type { Store } from '../db/store.js';
import type { Logger } from '../log.js';
import { findLeftovers, roots, stopLeftovers } from './leftovers.js';

/**
 * The work a run leaves running in the background, and ending it.
 *
 * A run normally ends only once its detached processes have exited, so there
 * is usually nothing to do here. It matters when the run was stopped,
 * finished early, or failed -- and it is what makes Stop mean stop for a
 * `nohup` job the harness never knew about.
 */

/** Tracked jobs in a run's activity: what Stop or Finish now is about to stop. */
export function trackedJobs(activity: RunActivity | null): number {
  return activity?.background.filter((job) => job.tracked).length ?? 0;
}

/** A process's command line, short enough for a card. */
export function describeProcess(command: string): string {
  const trimmed = command.trim() || 'a process';
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/**
 * A run's detached processes, as the jobs the interface shows: one per piece of
 * work rather than per process. Keyed by pid, which is stable for as long as
 * the process lives -- which is as long as it is shown.
 */
export async function detachedJobs(runId: string): Promise<BackgroundJob[]> {
  return roots(await findLeftovers(runId)).map((p) => ({
    id: `pid:${p.pid}`,
    description: describeProcess(p.command),
    tracked: false,
    startedAt: new Date().toISOString(),
  }));
}

/**
 * Best-effort teardown of observed processes carrying this run's marker. Said
 * in the transcript when it does anything; returns how many it stopped.
 */
export async function endLeftovers(
  deps: { store: Store; log: Logger },
  run: { runId: string; nodeId: string; projectId: string },
  /** The app is closing: shutdown waits only a few seconds, and a leftover is stopped either way. */
  closing: boolean,
): Promise<number> {
  const { runId, nodeId, projectId } = run;
  const stopped = await stopLeftovers(runId, closing ? 300 : 3_000);
  if (stopped.length === 0) return 0;
  deps.log.info('run.leftovers_stopped', { runId, nodeId, projectId, processes: stopped.length });
  deps.store.appendMessage({
    nodeId,
    runId,
    role: 'system',
    kind: 'text',
    content:
      `Stopped ${stopped.length === 1 ? 'a background process' : `${stopped.length} background processes`} ` +
      `still running when the run ended: ${stopped.map((p) => describeProcess(p.command)).join(' · ')}`,
  });
  return stopped.length;
}
