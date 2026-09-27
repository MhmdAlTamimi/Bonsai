import { type JSX, useCallback, useRef, useState } from 'react';
import type { NodeView } from '@bonsai/shared';

import { Dialog, DialogHeader } from '../Dialog.tsx';
import { IconButton } from '../Icon.tsx';
import { Checks } from '../panel/node/Checks.tsx';
import { useNodeDetail } from '../panel/node/useNodeDetail.ts';
import { useDismiss } from '../useDismiss.ts';

/**
 * What belongs with the RESULT rather than with the conversation: the checks
 * recorded for it. They were a disclosure under the thread, where they were
 * read past rather than read; they live on the review screen now, one menu
 * away from the change they describe. Applying the change has its own button
 * beside this menu.
 */
export function ReviewMenu({ node, revision }: { node: NodeView; revision: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'checks'>(null);
  const holder = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    holder,
    '[aria-haspopup]',
  );
  const { data } = useNodeDetail(node.id, revision);

  return (
    <div className="menu review-menu" ref={holder}>
      <IconButton
        icon="more"
        className="review-more"
        label="More about this result"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <div className="menu-panel right" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setDialog('checks');
            }}
          >
            Recorded checks
          </button>
        </div>
      )}

      {dialog === 'checks' && (
        <Dialog title="Recorded checks" onClose={() => setDialog(null)} returnFocus=".review-more">
          <DialogHeader title="Recorded checks" onClose={() => setDialog(null)} />
          <Checks node={node} detail={data} />
          <div className="dialog-actions">
            <button className="primary" onClick={() => setDialog(null)}>
              Close
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
