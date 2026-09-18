import type { JSX } from 'react';
import type { NodeView } from '@bonsai/shared';

import { Dialog } from '../../Dialog.tsx';
import { Details } from './Details.tsx';
import { Goal } from './Checks.tsx';
import { Lineage } from './Lineage.tsx';
import { useNodeDetail } from './useNodeDetail.ts';

/**
 * Everything about the experiment that is not its conversation.
 *
 * Opened from the card's ⋯, because these are properties of the NODE: what it
 * was for, where it came from, whether its code can still change, and the id a
 * bug report asks for. They used to sit under the thread, where they were
 * read once a week and scrolled past every minute.
 */
export function ExperimentDetails({
  node,
  onClose,
}: {
  node: NodeView;
  onClose: () => void;
}): JSX.Element {
  const { data, error } = useNodeDetail(node.id);
  return (
    <Dialog title={node.displayName} onClose={onClose} returnFocus=".card.selected .card-more">
      <h3>{node.displayName}</h3>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data === null && error === null && <p role="status">Loading experiment details…</p>}
      {data !== null && (
        <>
          <Goal detail={data} />
          <Lineage lineage={data.lineage} />
          <Details
            node={node}
            detail={data}
            runs={data.runs}
            isYourFolder={node.frozenReason === 'your_folder'}
          />
        </>
      )}
      <div className="dialog-actions">
        <button className="primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
