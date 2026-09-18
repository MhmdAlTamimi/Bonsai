import { type JSX, useEffect, useRef, useState } from 'react';
import { useCanRun } from '../../state/RunAvailability.ts';
import type { NodeView } from '@bonsai/shared';

/** One submission surface, with a compact question entry for read-only experiments. */
export function Composer({
  node,
  busy,
  sending,
  value,
  onChange,
  onSend,
  onBranch,
}: {
  node: NodeView;
  /** A run is in flight, or the node is parked on a question. */
  busy: boolean;
  sending: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** Branch a child from here, beside Send: the other thing a reply can become. */
  onBranch?: () => void;
}): JSX.Element {
  const canRun = useCanRun();
  const initial = node.status === 'new';
  const frozen = !node.writable;
  const [open, setOpen] = useState(!frozen);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Re-collapse when moving to another frozen node, so the panel does not stay
  // expanded because of a decision made about a different node.
  useEffect(() => {
    setOpen(!frozen);
  }, [node.id, frozen]);

  if (frozen && !open && !initial) {
    return (
      <div className="composer collapsed">
        <button
          className="composer-open"
          onClick={() => {
            setOpen(true);
            setTimeout(() => ref.current?.focus(), 0);
          }}
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
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canRun && !busy && !sending && value.trim()) onSend();
          }
        }}
        placeholder={initial ? 'Describe what the first run should do…' : placeholder(node, busy)}
        rows={2}
        aria-label="message"
      />
      <div className="composer-row">
        <span className="hint">
          {frozen
            ? node.frozenReason === 'your_folder'
              ? 'Read only — questions only'
              : 'Frozen — questions only'
            : canRun
              ? '⏎ send · ⇧⏎ newline'
              : 'Reconnect the agent to send'}
        </span>
        {onBranch !== undefined && (
          <button
            className="secondary"
            onClick={onBranch}
            title="Start a child experiment from this one, leaving this result intact"
          >
            Branch child
          </button>
        )}
        <button
          className="primary"
          onClick={onSend}
          disabled={!canRun || busy || sending || value.trim() === ''}
        >
          {sending ? (initial ? 'Starting…' : 'Sending…') : initial ? 'Start first run' : 'Send'}
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
