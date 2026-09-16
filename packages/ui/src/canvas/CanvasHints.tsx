import { type JSX, useCallback, useId, useRef, useState } from 'react';

import { Icon } from '../Icon.tsx';
import { useDismiss } from '../useDismiss.ts';

/**
 * What the shapes on the map mean, behind one toggle.
 *
 * This was a "Map key" panel with its own "Close map key" button inside it --
 * a second way to do what the trigger already did, sitting where the content
 * should be. A popover closes the way every popover closes: press the trigger
 * again, click away, or press Escape. Nothing about it needs explaining, so it
 * does not explain itself.
 *
 * Deliberately a popover rather than a dialog. It is a reference you read
 * WHILE looking at the map, so taking the map away to show it would defeat it;
 * it also means no focus trap, because there is nothing here to interact with.
 */
export function CanvasHints(): JSX.Element {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    container,
    '.canvas-hints-trigger',
  );

  return (
    <div className="canvas-hints" ref={container}>
      <button
        className="canvas-tool canvas-hints-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="What the shapes on the map mean"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="question" />
        <span>Canvas hints</span>
      </button>
      {open && (
        <div className="canvas-hints-panel" role="dialog" aria-labelledby={titleId}>
          <h3 id={titleId}>Reading the map</h3>
          <dl>
            <dt>Solid line</dt>
            <dd>The experiment changed code.</dd>
            <dt>Dashed line</dt>
            <dd>It answered without changing anything.</dd>
            <dt>Highlighted path</dt>
            <dd>The conversation the selected experiment inherited.</dd>
            <dt>Padlock</dt>
            <dd>Read-only: either a child has committed, or it is your own folder.</dd>
          </dl>
          <p className="hint">
            Drag the <Icon name="plus" /> handle onto empty canvas to branch. Dropping onto another
            experiment does nothing — this is a tree, not a graph.
          </p>
        </div>
      )}
    </div>
  );
}
