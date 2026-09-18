import { type JSX, useCallback, useRef, useState } from 'react';
import type { NodeView } from '@bonsai/shared';

import { Dialog } from '../Dialog.tsx';
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
export function ReviewMenu({
  node,
  revision,
  onError,
}: {
  node: NodeView;
  revision: string;
  onError: (message: string) => void;
}): JSX.Element {
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
      <button
        className="review-more"
        aria-label="More about this result"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More about this result"
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div className="menu-panel right" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setDialog('checks');
            }}
          >
            Recorded checks…
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
            Use this code outside Bonsai…
          </button>
        </div>
      )}

      {dialog === 'checks' && (
        <Dialog title="Recorded checks" onClose={() => setDialog(null)} returnFocus=".review-more">
          <h3>Recorded checks</h3>
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
          <h3>Use this code outside Bonsai</h3>
          <Checkout command={data.checkoutCommand} hint={data.checkoutHint} onError={onError} />
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
