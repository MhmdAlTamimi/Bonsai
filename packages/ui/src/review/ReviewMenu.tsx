import { type JSX, useCallback, useRef, useState } from 'react';
import type { NodeView } from '@bonsai/shared';

import { Dialog, DialogHeader } from '../Dialog.tsx';
import { IconButton } from '../Icon.tsx';
import { Checks } from '../panel/node/Checks.tsx';
import { Checkout } from '../panel/node/Checkout.tsx';
import { useNodeDetail } from '../panel/node/useNodeDetail.ts';
import { useDismiss } from '../useDismiss.ts';

/**
 * What belongs with the RESULT rather than with the conversation: the checks
 * recorded for it, and the command that opens it outside Bonsai.
 *
 * Both were disclosures under the thread, where they were read past rather
 * than read. They live on the review screen now, one menu away from the change
 * they describe.
 */
export function ReviewMenu({ node, revision }: { node: NodeView; revision: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<null | 'checks' | 'checkout'>(null);
  const holder = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    useCallback(() => setOpen(false), []),
    holder,
    '[aria-haspopup]',
  );
  const { data } = useNodeDetail(node.id, revision);
  const committed = data?.runs.some((run) => run.commitSha !== null) === true;

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
          <button
            role="menuitem"
            disabled={!committed || data?.checkoutCommand == null}
            title={
              committed ? undefined : 'This experiment has committed nothing to check out yet.'
            }
            onClick={() => {
              setOpen(false);
              setDialog('checkout');
            }}
          >
            Use this code outside Bonsai
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
      {dialog === 'checkout' && data?.checkoutCommand != null && (
        <Dialog
          title="Use this code outside Bonsai"
          onClose={() => setDialog(null)}
          returnFocus=".review-more"
        >
          <DialogHeader title="Use this code outside Bonsai" onClose={() => setDialog(null)} />
          <Checkout command={data.checkoutCommand} hint={data.checkoutHint} />
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
