import type { JSX } from 'react';

/**
 * The panel's one expand affordance.
 *
 * Exactly one shape, used for exactly two things: output a block has more of,
 * and a prompt longer than its clamp. Everything else in the panel is either
 * shown or somewhere else — a second disclosure pattern is how a conversation
 * turns into a filing cabinet.
 */
export function Disclosure({
  open,
  lines,
  onToggle,
}: {
  open: boolean;
  /** How many lines are hidden — the only number this row ever says. */
  lines: number;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button className="disclosure-row" aria-expanded={open} onClick={onToggle}>
      <span className="caret" aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
      <span>
        {open ? 'Hide' : lines.toLocaleString()} {open ? lines.toLocaleString() : 'more'} line
        {lines === 1 ? '' : 's'}
      </span>
    </button>
  );
}
