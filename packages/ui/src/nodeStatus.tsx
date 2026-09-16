import { Icon, type IconName } from './Icon.tsx';
import type { JSX } from 'react';
import type { NodeStatus, NodeView, RunEndReason } from '@bonsai/shared';

/**
 * A node's status, as a glyph, a word and a colour — in that order.
 *
 * The status is the most important thing on a card and it used to be an
 * eight-pixel coloured dot, which is no signal at all for the roughly eight
 * percent of men with a colour vision deficiency, and a poor one for everyone
 * at a glance. Colour is now the last of three cues rather than the only one.
 *
 * The glyphs are chosen to differ in SHAPE, not just in character: a hollow
 * ring, a spinner, a question mark, a tick, a warning triangle. Squint and the
 * five are still distinguishable.
 */

export const STATUS_GLYPH: Record<NodeStatus, IconName> = {
  new: 'circle',
  running: 'clock',
  needs_you: 'question',
  ready: 'finished',
  interrupted: 'warning',
};

export const STATUS_LABEL: Record<NodeStatus, string> = {
  new: 'Not started',
  running: 'Running',
  needs_you: 'Needs you',
  ready: 'Finished',
  interrupted: 'Interrupted',
};

const STATUS_TITLE: Record<NodeStatus, string> = {
  new: 'Created, but no run has started yet.',
  running: 'An agent is working in this node now.',
  needs_you: 'The agent asked a question and is waiting for an answer.',
  ready: 'The run finished. This does not mean its result was verified.',
  interrupted: 'The last run was stopped or failed. Its work is still in the folder.',
};

/** Said instead of Running while a run waits for background work (D43). */
const WAITING_TITLE =
  'The agent’s turn is over, and background work it started is still running. The run ends, and its results are saved, when that work does.';

export function StatusChip({
  status,
  queuePosition = null,
  compact = false,
  lastRunEndReason = null,
  waiting = false,
}: {
  status: NodeStatus;
  /** Why the last run ended, so a stopped or failed run says so rather than "Interrupted". */
  lastRunEndReason?: RunEndReason | null;
  waiting?: boolean;
  /** Shown instead of "running" while a node waits for a free slot. */
  queuePosition?: number | null;
  /** Glyph only, for places too narrow for the word. The word is in the title. */
  compact?: boolean;
}): JSX.Element {
  if (queuePosition !== null) {
    return (
      <span
        className="chip queued"
        title={`Waiting for a free slot (position ${queuePosition})`}
        aria-label={`Queued, position ${queuePosition}`}
      >
        <span className="glyph">
          <Icon name="clock" />
        </span>
        {!compact && `Queued #${queuePosition}`}
      </span>
    );
  }
  const ended = status !== 'running' && status !== 'needs_you';
  const label =
    status === 'running' && waiting
      ? 'Waiting'
      : ended && lastRunEndReason === 'failed'
        ? 'Failed'
        : ended && lastRunEndReason === 'stopped'
          ? 'Stopped'
          : STATUS_LABEL[status];
  const title =
    label === 'Waiting'
      ? WAITING_TITLE
      : label === 'Failed' || label === 'Stopped'
        ? `${label}. Review the conversation and any uncommitted work.`
        : STATUS_TITLE[status];
  return (
    <span className={`chip st-${status}`} title={title} aria-label={label}>
      <span className="glyph">
        <Icon name={label === 'Failed' ? 'warning' : STATUS_GLYPH[status]} />
      </span>
      {!compact && label}
    </span>
  );
}

/** The same three cues for a node, wherever a whole NodeView is to hand. */
export function nodeStatusTitle(node: NodeView): string {
  return `${STATUS_LABEL[node.status]} — ${STATUS_TITLE[node.status]}`;
}
