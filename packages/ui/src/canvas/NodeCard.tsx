import type { JSX } from 'react';
import { Handle, Position, useStore } from 'reactflow';
import { RANK_DIR } from './layout.ts';
import { CODE_LABEL, CODE_TOOLTIP, codeState } from '../nodeCode.ts';
import type { NodeView } from '@bonsai/shared';
import { api } from '../api/client.ts';

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

/**
 * D35: detail thins as you zoom out -- full card, then name + dot, then dot.
 *
 * The thresholds are deliberately low. React Flow zooms on the scroll wheel, so
 * a couple of stray trackpad flicks used to be enough to collapse every card to
 * a dot with no text on it, which reads as the nodes having disappeared rather
 * than as a zoom level. Dropping all the way to a dot should mean you asked to
 * see the whole shape of a large tree, not that you brushed the trackpad.
 */
type Lod = 'full' | 'compact' | 'dot';

function lodFor(zoom: number): Lod {
  if (zoom < 0.28) return 'dot';
  if (zoom < 0.55) return 'compact';
  return 'full';
}

/** Why the padlock is there. The two reasons lead to different next steps. */
const FROZEN_TOOLTIP: Record<NonNullable<NodeView['frozenReason']>, string> = {
  child_committed: 'Frozen — a child has committed, so this node\'s code cannot change.',
  your_folder:
    'Your own folder. Bonsai reads it but never writes or commits there; drag out a child to make changes.',
};

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

  // At dot level the card is sized in inverse proportion to the zoom, so it
  // stays a constant ~30px on screen. Without this the level-of-detail shrink
  // and the zoom shrink compound, and the "dot alone" overview D35 asks for
  // turns into single-digit pixels -- nodes that read as having vanished.
  const dotStyle =
    lod === 'dot' ? { width: `${30 / zoom}px`, height: `${30 / zoom}px` } : undefined;

  return (
    <div
      className={classes}
      style={dotStyle}
      title={`${data.displayName}\n\n${CODE_TOOLTIP[code]}`}
    >
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
              <span className="glyph" title={FROZEN_TOOLTIP[data.frozenReason ?? 'child_committed']}>
                &#128274;
              </span>
            )}
          </div>
          {lod === 'full' && (
            <>
              <div className="card-summary">{data.summaryLine || <em>no description</em>}</div>
              <div className="card-foot">
                {/* On the card as well as in the panel: with several nodes in
                    flight, the one you want to stop is rarely the one selected,
                    and stopping it should not cost a click to select it first. */}
                {data.status === 'running' ? (
                  <button
                    className="stop"
                    title="Stop this run"
                    onClick={(e) => {
                      // The card is a canvas node; without this the click
                      // selects it and React Flow starts a drag.
                      e.stopPropagation();
                      void api.cancelNode(data.id);
                    }}
                  >
                    ■ Stop
                  </button>
                ) : (
                  <span className="pill">{STATUS_LABEL[data.status]}</span>
                )}
                {data.costUsd > 0 && <span className="cost">${data.costUsd.toFixed(3)}</span>}
              </div>
            </>
          )}
        </>
      )}

      {/* The source handle IS the create-a-child affordance: drag it into empty
          canvas and name the child where you dropped it. Sized to be grabbable
          and marked with a + so it reads as an action rather than a port. */}
      <Handle
        type="source"
        position={RANK_DIR === 'TB' ? Position.Bottom : Position.Right}
        className="add-child-handle"
        title="drag out to create a child"
      />
    </div>
  );
}
