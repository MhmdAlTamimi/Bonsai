import { Icon, IconButton } from '../Icon.tsx';
import { type JSX, useCallback, useContext, useRef, useState } from 'react';
import { Handle, Position, useStore } from 'reactflow';
import { RANK_DIR } from './layout.ts';
import { CODE_TOOLTIP, codeState } from '../nodeCode.ts';
import type { NodeView } from '@bonsai/shared';
import { STATUS_LABEL, StatusChip, nodeStatusTitle } from '../nodeStatus.tsx';
import { BranchContext } from './branchContext.ts';
import { CardActionsContext, PickContext, cardMenuLabel } from './cardActions.ts';
import { compareTone } from '../state/compare.ts';
import { useDismiss } from '../useDismiss.ts';
import { useStopRun } from '../state/RunControls.tsx';
import { canDrawFrom } from '../state/references.ts';
import { plural } from '../words.ts';

/**
 * The node card. Renders from FLAGS, never from a node "type" string
 * (PRD §9 constraint 4).
 *
 * There is no `isExploration` here and there must never be one. A node with no
 * commits gets the dashed border and the chat glyph because `createsBranch` is
 * false -- an outcome of what its run did, not a category chosen up front.
 */

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
const ARCHIVED_TOOLTIP =
  'Archived: its folder was removed to save space. The branch, conversation and runs are kept, ' +
  'and the next run (or Open folder) brings the folder back and runs setup again.';

const FROZEN_TOOLTIP: Record<NonNullable<NodeView['frozenReason']>, string> = {
  child_committed: "Frozen — a child has committed, so this experiment's code cannot change.",
  your_folder:
    'Your own folder. Bonsai reads it but never writes or commits there; branch an experiment to make changes.',
};

export function NodeCard({ data, selected }: { data: NodeView; selected: boolean }): JSX.Element {
  const zoom = useStore((s) => s.transform[2]);
  const lod = lodFor(zoom);
  const branch = useContext(BranchContext);
  const actions = useContext(CardActionsContext);
  const pick = useContext(PickContext).get(data.id);
  const [menu, setMenu] = useState(false);
  const stopping = useStopRun(data);
  const card = useRef<HTMLDivElement>(null);
  useDismiss(
    menu,
    useCallback(() => setMenu(false), []),
    card,
    '.card-more',
  );

  // Dashed border and the conversation glyph mean "ran and wrote nothing", which is
  // only knowable once the run finished. A node that has not run yet gets
  // neither -- see nodeCode.ts.
  const code = codeState(data);
  const waiting = data.activity?.state === 'waiting';
  const changes = data.diffStat;

  const classes = [
    'card',
    `status-${data.status}`,
    `code-${code}`,
    data.writable ? 'writable' : 'frozen',
    selected ? 'selected' : '',
    data.folder === 'archived' ? 'archived' : '',
    pick === undefined ? '' : `picked ${compareTone(pick)}`,
    `lod-${lod}`,
  ]
    .filter(Boolean)
    .join(' ');

  // At dot level the card is sized in inverse proportion to the zoom, so it
  // stays a constant 44px on screen. Without this the level-of-detail shrink
  // and the zoom shrink compound, and the "dot alone" overview D35 asks for
  // turns into single-digit pixels -- nodes that read as having vanished.
  const dotStyle =
    lod === 'dot' ? { width: `${44 / zoom}px`, height: `${44 / zoom}px` } : undefined;

  return (
    <div
      className={classes}
      style={dotStyle}
      ref={card}
      title={`${data.displayName}\n\n${CODE_TOOLTIP[code]}`}
    >
      <Handle type="target" position={RANK_DIR === 'TB' ? Position.Top : Position.Left} />

      {lod === 'dot' ? (
        <span className="dot-only" aria-label={`${data.displayName}: ${STATUS_LABEL[data.status]}`}>
          <StatusChip
            status={data.status}
            queuePosition={data.queuePosition}
            lastRunEndReason={data.lastRunEndReason}
            waiting={waiting}
            compact
          />
        </span>
      ) : (
        <>
          <div className="card-head">
            <span
              className={`node-status-dot st-${data.status}`}
              aria-hidden="true"
              title={nodeStatusTitle(data)}
            />
            <span className="card-name">{data.displayName}</span>
            {pick !== undefined && (
              <span className="pick-badge" aria-label={`Picked to compare, ${pick + 1}`}>
                {pick + 1}
              </span>
            )}
            {!data.writable && (
              <span
                className="glyph lock"
                role="img"
                aria-label={FROZEN_TOOLTIP[data.frozenReason ?? 'child_committed']}
                title={FROZEN_TOOLTIP[data.frozenReason ?? 'child_committed']}
              >
                <Icon name="lock" />
              </span>
            )}
            {data.folder === 'archived' && (
              <span
                className="glyph archived-glyph"
                role="img"
                aria-label={ARCHIVED_TOOLTIP}
                title={ARCHIVED_TOOLTIP}
              >
                <Icon name="archive" />
              </span>
            )}
            {lod === 'full' && actions !== null && (
              <IconButton
                icon="more"
                size="xs"
                className="card-more nodrag nopan"
                label={cardMenuLabel(data.displayName)}
                title="Actions"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={(event) => {
                  event.stopPropagation();
                  setMenu((open) => !open);
                }}
              />
            )}
          </div>

          {lod === 'full' && (
            <>
              <div className="card-summary">
                {data.summaryLine.trim() === data.displayName.trim() ? '' : data.summaryLine}
              </div>
              <div className="card-foot">
                <StatusChip
                  status={data.status}
                  queuePosition={data.queuePosition}
                  lastRunEndReason={data.lastRunEndReason}
                  waiting={waiting}
                />
                <span className="spacer" />
                {/*
                 * The change summary IS the way in: a node that changed
                 * something always looks like something to read. A node that
                 * ran and changed nothing says so instead, and offers no
                 * control. A node that has not run yet claims neither -- see
                 * nodeCode.ts -- so its foot is the status alone.
                 *
                 * The count can be missing on a node that did commit: it is
                 * measured at commit time, and a run from before that
                 * measurement existed has none. The way in still opens.
                 */}
                {data.hasCommits ? (
                  <button
                    className="review-control nodrag nopan"
                    title={
                      changes === null
                        ? 'Review this experiment’s changes'
                        : `Review ${plural(changes.files, 'changed file')}`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      actions?.review(data.id);
                    }}
                  >
                    <span className="review-label">Review</span>
                    {changes !== null && (
                      <span
                        className={`review-count${data.status === 'running' ? ' running' : ''}`}
                      >
                        +{changes.added.toLocaleString()}
                      </span>
                    )}
                    <span className="review-arrow" aria-hidden="true">
                      <Icon name="arrowRight" />
                    </span>
                  </button>
                ) : (
                  code === 'none' && <span className="no-change">no file changes</span>
                )}
              </div>
            </>
          )}

          {menu && actions !== null && (
            <div className="menu-panel card-menu nodrag nopan" role="menu">
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  actions.review(data.id);
                }}
              >
                Review changes
              </button>
              {data.diffStat !== null && (
                <button
                  role="menuitem"
                  title="Show the command that applies this experiment's committed changes to your own repository"
                  onClick={() => {
                    setMenu(false);
                    actions.apply(data);
                  }}
                >
                  Apply to your repo
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  actions.branch(data.id);
                }}
              >
                Branch experiment
              </button>
              {stopping !== null && (
                <button
                  role="menuitem"
                  className="stop-run"
                  disabled={stopping.busy}
                  aria-busy={stopping.busy}
                  onClick={() => {
                    setMenu(false);
                    stopping.stop();
                  }}
                >
                  Stop run
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  actions.rename(data);
                }}
              >
                Rename
              </button>
              {data.hasConversation && (
                <button
                  role="menuitem"
                  disabled={data.status === 'running' || data.status === 'needs_you'}
                  title="Summarise older turns to free context, as /compact does"
                  onClick={() => {
                    setMenu(false);
                    actions.compact(data);
                  }}
                >
                  Compact conversation
                </button>
              )}
              {canDrawFrom(data) && (
                <button
                  role="menuitem"
                  title="Write a reference from this experiment's conversation"
                  onClick={() => {
                    setMenu(false);
                    actions.reference(data);
                  }}
                >
                  Save as reference
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  actions.details(data);
                }}
              >
                Experiment details
              </button>
              {data.folder === 'present' && data.frozenReason !== 'your_folder' && (
                <button
                  role="menuitem"
                  disabled={data.status === 'running' || data.status === 'needs_you'}
                  title="Remove the folder to save space. The branch, conversation and runs stay, and the next run brings it back."
                  onClick={() => {
                    setMenu(false);
                    actions.archive(data);
                  }}
                >
                  Archive folder
                </button>
              )}
              {data.parentId !== null && <div className="menu-sep" role="separator" />}
              {data.parentId !== null && (
                <button
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    setMenu(false);
                    actions.remove(data);
                  }}
                >
                  Delete experiment
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* The source handle IS the create-a-child affordance: click it, or drag
          it into empty canvas and name the child where you dropped it. */}
      <Handle
        type="source"
        position={RANK_DIR === 'TB' ? Position.Bottom : Position.Right}
        className="add-child-handle nodrag"
        role="button"
        tabIndex={0}
        aria-label={`Branch an experiment from ${data.displayName}`}
        title="Branch an experiment — click, or drag onto the map to place it"
        onClick={() => branch?.(data.id)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || (event.key !== 'Enter' && event.key !== ' ')) return;
          // The card underneath treats Enter as "select me"; this one is "branch".
          event.preventDefault();
          event.stopPropagation();
          branch?.(data.id);
        }}
      >
        <Icon name="plus" />
      </Handle>
    </div>
  );
}
