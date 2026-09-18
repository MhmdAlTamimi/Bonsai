import type { JSX } from 'react';

/**
 * The panel's one expand affordance.
 *
 * Exactly one shape, used for the few things that are longer than their
 * bound: a block's output, a prompt past its clamp, a long table, and the
 * setup that happened before the conversation started. Everything else is
 * either shown or somewhere else — a second disclosure pattern is how a
 * conversation turns into a filing cabinet.
 */
export function Disclosure({
  open,
  lines,
  label,
  unit = 'line',
  onToggle,
}: {
  open: boolean;
  /** How much is hidden. Ignored when `label` is given. */
  lines?: number;
  /** For the one row that hides something other than a count of lines. */
  label?: string;
  unit?: string;
  onToggle: () => void;
}): JSX.Element {
  const count = lines ?? 0;
  const plural = count === 1 ? unit : `${unit}s`;
  return (
    <button className="disclosure-row" aria-expanded={open} onClick={onToggle}>
      <span className="caret" aria-hidden="true">
        {open ? '\u25be' : '\u25b8'}
      </span>
      <span>
        {label ??
          (open
            ? `Hide ${count.toLocaleString()} ${plural}`
            : `${count.toLocaleString()} more ${plural}`)}
      </span>
    </button>
  );
}
