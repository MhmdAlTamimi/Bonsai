import type { JSX } from 'react';
import { Handle, Position, useStore } from 'reactflow';
import { RANK_DIR } from './layout.ts';
import { CODE_LABEL, codeState } from '../nodeCode.ts';
import type { NodeView } from '@bonsai/shared';

/**
 * The node card. Renders from FLAGS, never from a node "type" string
 * (PRD §9 constraint 4).
 *
 * There is no `isExploration` here and there must never be one. A node with no
 * commits gets the dashed border and the chat glyph because `createsBranch` is
 * false -- an outcome of what its run did, not a category chosen up front.
 */

const STATUS_LABEL: Record<NodeView['status'], string> = {
  new: 'not started',
  running: 'running',
  needs_you: 'needs you',
  ready: 'ready',
  interrupted: 'interrupted',
};

/** D35: detail thins as you zoom out -- full card, then name + dot, then dot. */
type Lod = 'full' | 'compact' | 'dot';

function lodFor(zoom: number): Lod {
  if (zoom < 0.4) return 'dot';
  if (zoom < 0.75) return 'compact';
  return 'full';
}

export function NodeCard({ data, selected }: { data: NodeView; selected: boolean }): JSX.Element {
  const zoom = useStore((s) => s.transform[2]);
  const lod = lodFor(zoom);

  // Dashed border and the envelope glyph mean "ran and wrote nothing", which is
  // only knowable once the run finished. A node that has not run yet gets
  // neither -- see nodeCode.ts.
  const code = codeState(data);

  const classes = [
    'card',
    `status-${data.status}`,
    `code-${code}`,
    data.writable ? 'writable' : 'frozen',
    selected ? 'selected' : '',
    `lod-${lod}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} title={data.displayName}>
      <Handle type="target" position={RANK_DIR === 'TB' ? Position.Top : Position.Left} />

      {lod === 'dot' ? (
        <span className="dot-only" aria-label={`${data.displayName}: ${STATUS_LABEL[data.status]}`} />
      ) : (
        <>
          <div className="card-head">
            <span className="status-dot" />
            <span className="card-name">{data.displayName}</span>
            {/* No diff to show, so say so rather than hiding it. */}
            {code === 'none' && (
              <span className="glyph" title={CODE_LABEL[code]}>
                &#9993;
              </span>
            )}
            {!data.writable && (
              <span className="glyph" title="frozen — a child has committed">
                &#128274;
              </span>
            )}
          </div>
          {lod === 'full' && (
            <>
              <div className="card-summary">{data.summaryLine || <em>no description</em>}</div>
              <div className="card-foot">
                <span className="pill">{STATUS_LABEL[data.status]}</span>
                {data.costUsd > 0 && <span className="cost">${data.costUsd.toFixed(3)}</span>}
              </div>
            </>
          )}
        </>
      )}

      <Handle type="source" position={RANK_DIR === 'TB' ? Position.Bottom : Position.Right} />
    </div>
  );
}
