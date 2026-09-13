import { type JSX, useEffect, useRef, useState } from 'react';
import type { NodeView } from '@bonsai/shared';

/**
 * The box you type in, sized to how much it is actually wanted.
 *
 * A node is writable only while it is a leaf, so most nodes in a tree are
 * frozen most of the time -- and on a frozen node the composer used to be the
 * largest thing in the panel: a three-row textarea, disabled, whose placeholder
 * explained that it was disabled. That is the worst possible use of the space
 * above the fold, and it pushed the one action actually available (branch a
 * child off this node) below it.
 *
 * So on a frozen node this collapses to a single line. The node is still
 * conversational -- you can ask it anything, it just cannot write -- and one
 * click opens the box for that. Nothing is removed; it stops claiming the room.
 */
export function Composer({
  node,
  busy,
  sending,
  emphasised,
  value,
  onChange,
  onSend,
}: {
  node: NodeView;
  /** A run is in flight, or the node is parked on a question. */
  busy: boolean;
  sending: boolean;
  /**
   * Whether Send is THE action here. False when the panel is already showing a
   * primary above it -- a `new` node's Start button -- because the stylesheet's
   * first rule is that two accent buttons on one screen means one of them is
   * wrong, and here the wrong one is Send.
   */
  emphasised: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
}): JSX.Element {
  const frozen = !node.writable;
  const [open, setOpen] = useState(!frozen);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Re-collapse when moving to another frozen node, so the panel does not stay
  // expanded because of a decision made about a different node.
  useEffect(() => {
    setOpen(!frozen);
  }, [node.id, frozen]);

  if (frozen && !open) {
    return (
      <div className="composer collapsed">
        <button
          className="composer-open"
          onClick={() => {
            setOpen(true);
            setTimeout(() => ref.current?.focus(), 0);
          }}
          disabled={busy}
        >
          Ask a question&hellip;
        </button>
        <span className="hint">
          {node.frozenReason === 'your_folder'
            ? 'Read only — your own folder'
            : 'Frozen — a child committed'}
        </span>
      </div>
    );
  }

  return (
    <div className="composer">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline, as in any chat box.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={placeholder(node, busy)}
        rows={3}
        disabled={busy}
        aria-label="message"
      />
      <div className="composer-row">
        <span className="hint">
          {frozen
            ? node.frozenReason === 'your_folder'
              ? 'Read only — questions only'
              : 'Frozen — questions only'
            : 'Enter to send'}
        </span>
        <button
          className={emphasised ? 'primary' : ''}
          onClick={onSend}
          disabled={busy || sending || value.trim() === ''}
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function placeholder(node: NodeView, busy: boolean): string {
  if (node.status === 'needs_you') return 'Answer the question above to let it carry on.';
  if (busy) return 'The agent is working…';
  if (node.writable) return 'Reply, ask a question, or describe a change…';
  return node.frozenReason === 'your_folder'
    ? 'Your own folder — ask about it; branch a child to change anything.'
    : 'This node is frozen — you can still ask questions.';
}
