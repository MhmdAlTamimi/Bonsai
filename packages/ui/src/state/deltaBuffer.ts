import type { Delta } from '../panel/chat/liveMerge.ts';

/**
 * What the live stream keeps, and what it lets go.
 *
 * Live output is a VIEW of a run in flight, not the record of it: every
 * persisted message is in the database and the transcript re-reads it from
 * there. So the only deltas worth holding are the ones the persisted transcript
 * has not caught up with (see liveMerge.ts) -- and nothing ever dropped one.
 * An agent working for an hour publishes thousands of frames, and a project
 * left open across several runs held every frame of all of them.
 */

/** Generous enough that the tail a reader can actually see is always present. */
export const MAX_DELTAS_PER_NODE = 400;

/**
 * Adds one delta to a node's buffer, returning the same array when nothing
 * changed so React can skip the render.
 *
 * Three rules, each for a case that was costing something:
 *
 *   A REPEATED frame is ignored. Numbered deltas carry their run and sequence,
 *   so a duplicate or a replayed frame is identifiable rather than appended.
 *
 *   UNPERSISTED TEXT IS MERGED. Setup output arrives as many small `seq: 0`
 *   chunks -- `npm install` on a cold cache emits hundreds -- and each one used
 *   to be its own entry, its own state update and its own re-render, at the one
 *   moment the canvas can least afford them. Consecutive plain text from the
 *   same run grows the entry that is already there. Tool frames are never
 *   merged: they carry structure the transcript renders on its own.
 *
 *   THE BUFFER IS BOUNDED. Oldest first, because the interesting end of a live
 *   stream is the new end.
 */
export function appendDelta(list: readonly Delta[], delta: Delta): readonly Delta[] {
  if (delta.seq > 0 && list.some((d) => d.runId === delta.runId && d.seq === delta.seq)) {
    return list;
  }

  const last = list.at(-1);
  const structured = (d: Delta): boolean => d.tool !== undefined || d.toolResult !== undefined;
  const open =
    delta.seq === 0 &&
    !structured(delta) &&
    last?.seq === 0 &&
    !structured(last) &&
    last.runId === delta.runId
      ? last
      : null;

  const next =
    open === null
      ? [...list, delta]
      : [...list.slice(0, -1), { ...open, text: open.text + delta.text }];

  return next.length > MAX_DELTAS_PER_NODE ? next.slice(next.length - MAX_DELTAS_PER_NODE) : next;
}
