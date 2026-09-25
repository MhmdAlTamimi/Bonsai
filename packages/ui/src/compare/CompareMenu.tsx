import { type JSX, useCallback, useRef, useState } from 'react';

import { Icon } from '../Icon.tsx';
import { useDismiss } from '../useDismiss.ts';

/** The comparison's own ⋯: the rare, destructive thing, kept out of the way. */
export function CompareMenu({ onDelete }: { onDelete: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    holder,
    '[aria-haspopup]',
  );
  return (
    <div className="menu review-menu" ref={holder}>
      <button
        className="review-more"
        aria-label="More for this comparison"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="menu-panel right" role="menu">
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            Delete comparison…
          </button>
        </div>
      )}
    </div>
  );
}
