/**
 * Which live deltas the persisted transcript has not caught up with.
 *
 * A run writes each message to the database AND publishes it as a delta, so
 * while a run is in flight the same sentence can arrive twice: once as a
 * `run.delta` frame and, a moment later, as a row in `messages`. Something has
 * to decide which copy to draw, or the transcript doubles.
 *
 * The previous rule was `live.slice(persistedAssistantCount)` -- index into the
 * delta stream by a count of persisted messages. That assumes the two are the
 * same sequence, and they are not, in two ways that both show up as garbled
 * output rather than as an error:
 *
 *   1. A project with a setup command publishes deltas for the command line and
 *      for EVERY CHUNK of its output (`seq: 0`), and persists none of them. So
 *      `npm install` printing twelve chunks pushes twelve entries onto the
 *      front of the stream, `slice(1)` starts twelve entries too early, and the
 *      agent's own replies render a second time underneath themselves.
 *
 *   2. `seq` restarts at 0 for each run, while `messages` accumulates across
 *      every run on the node. On a node's second run the count starts at
 *      whatever the first run left behind, so the opening of the second run is
 *      sliced away and never appears.
 *
 * The fix uses what the wire already carries and the client was discarding:
 * every delta has a `runId` and a `seq`, and the server increments `seq` in
 * lockstep with the assistant messages it persists. So a delta is redundant
 * exactly when its `seq` is at or below the number of assistant messages
 * already stored FOR THAT RUN. Reconciling by key instead of by array position
 * is also what makes this survive a duplicate or out-of-order frame.
 *
 * `seq: 0` means "published, never persisted" -- setup output and run errors.
 * Those have no row to be replaced by, so they show for as long as the stream
 * holds them.
 */

export interface Delta {
  runId: string;
  /** 1-based within its run; 0 for output that is never persisted. */
  seq: number;
  text: string;
}

/** The fields of a persisted message this needs, and no more. */
export interface PersistedMessage {
  role: 'user' | 'assistant' | 'system';
  runId: string | null;
}

/**
 * The deltas still worth drawing, in arrival order.
 *
 * Only ever the newest run's: a delta from an earlier run is, by definition,
 * finished and persisted.
 */
export function pendingDeltas(
  deltas: readonly Delta[],
  persisted: readonly PersistedMessage[],
): Delta[] {
  const current = deltas.at(-1)?.runId;
  if (current === undefined) return [];

  const stored = persisted.filter((m) => m.role === 'assistant' && m.runId === current).length;

  return deltas.filter((d) => d.runId === current && (d.seq === 0 || d.seq > stored));
}
