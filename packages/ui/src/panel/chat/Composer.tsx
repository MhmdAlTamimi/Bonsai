import { type JSX, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCanRun } from '../../state/RunAvailability.ts';
import type { NextRunSettings, NodeView } from '@bonsai/shared';
import { PERMISSIONS } from '../AgentFields.tsx';
import { useDismiss } from '../../useDismiss.ts';

/** How many lines the box grows to before it scrolls inside itself. */
const MAX_LINES = 5;

/** One submission surface, with a compact question entry for read-only experiments. */
export function Composer({
  node,
  busy,
  sending,
  value,
  onChange,
  onSend,
  nextRun,
  onProjectSettings,
}: {
  node: NodeView;
  /** A run is in flight, or the node is parked on a question. */
  busy: boolean;
  sending: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** What the next run would use, behind the row's ⋯ — settings, not conversation. */
  nextRun?: NextRunSettings | null;
  onProjectSettings?: () => void;
}): JSX.Element {
  const canRun = useCanRun();
  const initial = node.status === 'new';
  const frozen = !node.writable;
  const [open, setOpen] = useState(!frozen);
  const ref = useRef<HTMLTextAreaElement>(null);

  /**
   * The box grows with the draft, to five lines, and then scrolls inside
   * itself — the one place in the panel allowed its own scroll, because Send
   * must never be pushed out of the window by something you are typing.
   */
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null) return;
    const style = getComputedStyle(box);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const padding =
      Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) || 0;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight, Math.round(line * MAX_LINES + padding))}px`;
  }, [value, open]);

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
        rows={1}
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
        {nextRun != null && <NextRun value={nextRun} onProjectSettings={onProjectSettings} />}
        <button
          className="primary"
          onClick={onSend}
          disabled={!canRun || busy || sending || value.trim() === ''}
          aria-label={initial ? 'Start first run' : 'Send'}
        >
          <span className="send-label">
            {sending ? (initial ? 'Starting…' : 'Sending…') : initial ? 'Start first run' : 'Send'}
          </span>
          {/* Shown instead of the label when the panel is too narrow to hold
              a hint and two buttons — the design's other composer. */}
          <span className="send-arrow" aria-hidden="true">
            ↑
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * What the next run would use, one ⋯ away from the box that starts it.
 *
 * It used to be a disclosure parked under the thread, where it described a run
 * that had not happened yet in the middle of the ones that had. Nothing is
 * decided here: the menu says what is set and offers the settings that set it.
 */
function NextRun({
  value,
  onProjectSettings,
}: {
  value: NextRunSettings;
  onProjectSettings?: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    holder,
    '[aria-haspopup]',
  );
  return (
    <div className="menu composer-menu" ref={holder}>
      <button
        className="composer-more"
        aria-label="Settings for the next run"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Next run · ${value.model ?? 'Agent default'}`}
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open && (
        <div className="menu-panel right up next-run" role="menu">
          <div className="menu-label">Next run</div>
          <dl>
            <div>
              <dt>Model</dt>
              <dd>
                {value.model ?? 'Agent default'} <small>{value.modelSource}</small>
              </dd>
            </div>
            <div>
              <dt>Effort</dt>
              <dd>
                {value.effort ?? 'Agent default'} <small>{value.effortSource}</small>
              </dd>
            </div>
            <div>
              <dt>Permissions</dt>
              <dd>
                {PERMISSIONS[value.permissionMode]} <small>{value.permissionSource}</small>
              </dd>
            </div>
          </dl>
          {onProjectSettings && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onProjectSettings();
              }}
            >
              Project settings…
            </button>
          )}
        </div>
      )}
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
