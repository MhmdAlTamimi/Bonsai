import type { JSX } from 'react';
import type { NodeStatus, NodeView } from '@bonsai/shared';

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

export const STATUS_GLYPH: Record<NodeStatus, string> = {
  new: '○',
  running: '◐',
  needs_you: '?',
  ready: '✓',
  interrupted: '▲',
};

export const STATUS_LABEL: Record<NodeStatus, string> = {
  new: 'not started',
  running: 'running',
  needs_you: 'needs you',
  ready: 'ready',
  interrupted: 'stopped',
};

const STATUS_TITLE: Record<NodeStatus, string> = {
  new: 'Created, but no run has started yet.',
  running: 'An agent is working in this node now.',
  needs_you: 'The agent asked a question and is waiting for an answer.',
  ready: 'The last run finished.',
  interrupted: 'The last run was stopped or failed. Its work is still in the folder.',
};

export function StatusChip({
  status,
  queuePosition = null,
  compact = false,
}: {
  status: NodeStatus;
  /** Shown instead of "running" while a node waits for a free slot. */
  queuePosition?: number | null;
  /** Glyph only, for places too narrow for the word. The word is in the title. */
  compact?: boolean;
}): JSX.Element {
  if (queuePosition !== null) {
    return (
      <span className="chip queued" title={`Waiting for a free slot (position ${queuePosition})`}>
        <span className="glyph">⋯</span>
        {!compact && `queued #${queuePosition}`}
      </span>
    );
  }
  return (
    <span className={`chip st-${status}`} title={STATUS_TITLE[status]}>
      <span className="glyph">{STATUS_GLYPH[status]}</span>
      {!compact && STATUS_LABEL[status]}
    </span>
  );
}

/** The same three cues for a node, wherever a whole NodeView is to hand. */
export function nodeStatusTitle(node: NodeView): string {
  return `${STATUS_LABEL[node.status]} — ${STATUS_TITLE[node.status]}`;
}
