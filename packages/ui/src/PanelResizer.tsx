import { type JSX, useCallback, useEffect, useRef } from 'react';
import { PANEL_WIDTH } from '@bonsai/shared';

/**
 * The divider between the canvas and the side panel.
 *
 * The panel is where diffs and transcripts are read, and eleven-pixel monospace
 * in a fixed 360px column is the most-used and least-comfortable surface in the
 * app. This makes it as wide as the reading needs.
 *
 * The width is written to a CSS variable on <html> rather than into React
 * state, deliberately: a state update per mousemove would re-render the tree
 * — React Flow included — on every frame of the drag. The variable drives the
 * grid directly, so dragging costs a style recalculation and nothing else.
 *
 * It is persisted through the settings endpoint. The project's rule is that
 * nothing persists in browser storage, and while a panel width is a view
 * preference rather than app state, there is no reason to make it the one
 * exception when settings are already there. Written on release, not during
 * the drag, so one gesture is one request.
 */
export function PanelResizer({
  width,
  min,
  max,
  onCommit,
}: {
  width: number;
  min: number;
  max: number;
  /** Called once, when the drag ends. */
  onCommit: (width: number) => void;
}): JSX.Element {
  const dragging = useRef(false);
  const latest = useRef(width);

  const apply = useCallback(
    (px: number) => {
      const clamped = Math.min(max, Math.max(min, Math.round(px)));
      latest.current = clamped;
      document.documentElement.style.setProperty('--panel-width', `${clamped}px`);
    },
    [min, max],
  );

  // Keeps the variable in step when the width changes from elsewhere -- the
  // initial load from settings, mainly.
  useEffect(() => {
    apply(width);
  }, [width, apply]);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!dragging.current) return;
      e.preventDefault();
      // The panel is on the right, so its width is the distance from the
      // pointer to the right-hand edge of the window.
      apply(window.innerWidth - e.clientX);
    };
    const onUp = (): void => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.classList.remove('resizing');
      onCommit(latest.current);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [apply, onCommit]);

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side panel"
      aria-valuenow={latest.current}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onMouseDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        // Stops the drag from selecting text across the whole page, and keeps
        // the resize cursor while the pointer is over the canvas.
        document.body.classList.add('resizing');
      }}
      onDoubleClick={() => {
        apply(PANEL_WIDTH.default);
        onCommit(PANEL_WIDTH.default);
      }}
      // Keyboard, because a divider only reachable by mouse is not reachable.
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === 'ArrowLeft') apply(latest.current + step);
        else if (e.key === 'ArrowRight') apply(latest.current - step);
        else return;
        e.preventDefault();
        onCommit(latest.current);
      }}
      title="Drag to resize · double-click to reset"
    />
  );
}
