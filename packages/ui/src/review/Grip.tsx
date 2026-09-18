import { type JSX, type PointerEvent, useRef } from 'react';

/**
 * The seam between two resizable panels.
 *
 * 8px wide with -8px margins, so the visible seam stays the 8px gap the layout
 * already has, and the whole of it is the target rather than a 1px line.
 */
export function Grip({
  label,
  onDrag,
}: {
  label: string;
  /** Pixels moved since the drag started. */
  onDrag: (delta: number) => void;
}): JSX.Element {
  const start = useRef<number | null>(null);
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    if (start.current === null) return;
    onDrag(event.clientX - start.current);
    start.current = event.clientX;
  };
  return (
    <div
      className="grip"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = event.clientX;
      }}
      onPointerMove={move}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        onDrag(event.key === 'ArrowRight' ? 16 : -16);
      }}
    >
      <span className="grip-pill" aria-hidden="true" />
    </div>
  );
}
