import type { JSX } from 'react';
import type { NodeView } from '@bonsai/shared';

import { Icon, IconButton } from '../Icon.tsx';
import { COMPARE_MAX, COMPARE_MIN, compareTone } from '../state/compare.ts';

/**
 * Picking experiments to compare, as a bar over the map.
 *
 * It says what to do while nothing is picked, shows what is, in the colours
 * the comparison will use, and offers Compare once there are enough. The map
 * stays usable underneath: picking is clicking the cards you are looking at.
 */
export function CompareBar({
  picks,
  nodes,
  busy,
  error,
  onCompare,
  onRemove,
  onCancel,
}: {
  picks: readonly string[];
  nodes: readonly NodeView[];
  busy: boolean;
  error: string | null;
  onCompare: () => void;
  onRemove: (id: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const picked = picks.flatMap((id) => nodes.find((node) => node.id === id) ?? []);
  const count = picked.length;
  const guidance =
    count === 0
      ? `Click ${COMPARE_MIN} to ${COMPARE_MAX} experiments on the map to compare them.`
      : count < COMPARE_MIN
        ? `Pick ${COMPARE_MIN - count} more.`
        : count >= COMPARE_MAX
          ? `${COMPARE_MAX} at most. Remove one to pick another.`
          : null;
  return (
    <div
      className="compare-bar nodrag nopan"
      role="region"
      aria-label="Pick experiments to compare"
    >
      <Icon name="compare" />
      {count > 0 && (
        <ul className="compare-picks" aria-label="Picked">
          {picked.map((node, position) => (
            <li key={node.id} className={`pick-chip ${compareTone(position)}`}>
              <span className="pick-number" aria-hidden="true">
                {position + 1}
              </span>
              <span className="pick-name">{node.displayName}</span>
              <IconButton
                icon="close"
                size="xs"
                className="pick-remove"
                label={`Remove ${node.displayName}`}
                disabled={busy}
                onClick={() => onRemove(node.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {guidance !== null && <span className="compare-guidance">{guidance}</span>}
      {error !== null && (
        <span className="error" role="alert">
          {error}
        </span>
      )}
      <button
        className="primary"
        disabled={count < COMPARE_MIN || busy}
        aria-busy={busy}
        onClick={onCompare}
      >
        {`Compare ${count < COMPARE_MIN ? '' : count}`.trim()}
      </button>
      <IconButton
        icon="close"
        className="compare-cancel"
        label="Stop picking"
        title="Stop picking (Esc)"
        disabled={busy}
        onClick={onCancel}
      />
    </div>
  );
}
