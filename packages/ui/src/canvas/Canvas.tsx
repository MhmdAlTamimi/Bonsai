import { type JSX, useRef } from 'react';
import ReactFlow, { Background, type NodeMouseHandler, useReactFlow, useStore } from 'reactflow';
import 'reactflow/dist/style.css';
import type { NodeView } from '@bonsai/shared';

import { Icon } from '../Icon.tsx';

import { CanvasHints } from './CanvasHints.tsx';
import { MAX_ZOOM, MIN_ZOOM } from './zoom.ts';

/** The canvas grid, in step with `--canvas-dot` in styles.css. */
const CANVAS_DOT = 'rgba(255, 255, 255, 0.075)';
import { NodeCard } from './NodeCard.tsx';
import { BonsaiEdge } from './BonsaiEdge.tsx';
import { BranchContext } from './branchContext.ts';
import { CardActionsContext, type CardActions } from './cardActions.ts';
import { useLaidOutNodes } from './useLaidOutNodes.ts';

const nodeTypes = { bonsai: NodeCard };
const edgeTypes = { bonsai: BonsaiEdge };

export interface BranchTarget {
  parentId: string;
  parentName: string;
  /** Where a drag was released, or null for a click, which lets the layout place it. */
  position: { x: number; y: number } | null;
}

/**
 * The tree, drawn. Everything React Flow knows about lives here or in
 * useLaidOutNodes, and nothing else in the interface touches it.
 */
export function Canvas({
  nodes,
  selectedId,
  onSelect,
  onToggleSelect,
  onMoved,
  onBranch,
  actions,
  onAutomatic,
}: {
  nodes: readonly NodeView[];
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  onToggleSelect: (nodeId: string) => void;
  onAutomatic: (nodeId: string) => void;
  onMoved: (nodeId: string, position: { x: number; y: number }) => void;
  /** A card's `+`: clicked or pressed, or dragged out and released over empty canvas. */
  onBranch: (target: BranchTarget) => void;
  /** What a card's own controls do: review, branch, rename, delete. */
  actions: CardActions;
}): JSX.Element {
  const selected = nodes.find((node) => node.id === selectedId);
  const { flowNodes, edges, onNodesChange } = useLaidOutNodes(nodes, selectedId);
  const zoom = useStore((state) => state.transform[2]);

  // Behind a ref for the same reason fitView is: useReactFlow() hands back a
  // new identity whenever the viewport moves.
  const { screenToFlowPosition, fitView, zoomIn, zoomOut, zoomTo } = useReactFlow();
  const screenToFlowRef = useRef(screenToFlowPosition);
  screenToFlowRef.current = screenToFlowPosition;

  /** Set between connect start and connect end. See onConnectEnd. */
  const dragSource = useRef<string | null>(null);

  const onNodeClick: NodeMouseHandler = (event, node) => {
    // Multi-select is wired now even though V0 reads only the first element.
    if (event.metaKey || event.ctrlKey) onToggleSelect(node.id);
    else onSelect(node.id);
  };

  /**
   * Dragging out of a node's handle and releasing on empty canvas creates a
   * child there. React Flow has no "connect to nowhere" event, so the source is
   * recorded on connect start and the drop is inspected on connect end: a
   * release over the pane (rather than over another node's handle) is the
   * gesture. Releasing onto a node does nothing -- D1 keeps this a tree, so
   * there is no second parent to connect to.
   */
  const onConnectEnd = (event: MouseEvent | TouchEvent): void => {
    const parentId = dragSource.current;
    dragSource.current = null;
    if (parentId === null) return;

    const target = event.target as HTMLElement | null;
    if (!target?.classList.contains('react-flow__pane')) return;

    const point = 'clientX' in event ? event : event.changedTouches[0];
    if (point === undefined) return;

    onBranch({
      parentId,
      parentName: nodes.find((n) => n.id === parentId)?.displayName ?? 'this node',
      position: screenToFlowRef.current({ x: point.clientX, y: point.clientY }),
    });
  };

  /** A click or a key on a card's `+`: the same dialog, placed by the layout. */
  const branchFrom = (parentId: string): void =>
    onBranch({
      parentId,
      parentName: nodes.find((n) => n.id === parentId)?.displayName ?? 'this node',
      position: null,
    });

  return (
    <CardActionsContext.Provider value={actions}>
      <BranchContext.Provider value={branchFrom}>
        <ReactFlow
          nodes={flowNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onConnectStart={(_event, params: { nodeId: string | null }) => {
            dragSource.current = params.nodeId;
          }}
          onConnectEnd={onConnectEnd}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeClick={onNodeClick}
          onNodeDragStop={(_event, node) => onMoved(node.id, node.position)}
          /**
           * A click is not a drag, and pinning is a deliberate act.
           *
           * React Flow's threshold defaults to 0, so a plain mousedown/mouseup on a
           * card started and ended a drag -- which fired onNodeDragStop and wrote a
           * position. Selecting an experiment therefore pinned it, silently: from
           * then on the layout never moved it again, and "Automatic position"
           * appeared for a node nobody had dragged. Four pixels of slop is enough
           * that an ordinary click never crosses it.
           */
          nodeDragThreshold={4}
          // Deliberately NOT clearing the selection on a pane click. The panel
          // is the primary workspace (§7), and emptying it because a click
          // landed between two cards loses your place for no gain -- selecting
          // another node replaces it anyway.
          minZoom={MIN_ZOOM}
          nodesConnectable
          connectOnClick={false}
          onKeyDownCapture={(event) => {
            if (event.nativeEvent.isComposing || !['Enter', ' '].includes(event.key)) return;
            const target = event.target as HTMLElement;
            if (!target.classList.contains('react-flow__node')) return;
            const id = target.dataset['id'];
            if (id) {
              event.preventDefault();
              onSelect(id);
              // Space chooses an experiment; Enter goes on to read its changes.
              if (event.key === 'Enter') actions.review(id);
            }
          }}
          maxZoom={MAX_ZOOM}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          {/* The dot grid: what tells you this is a surface you move on rather
              than a page, and the only thing that shows it moving when you pan
              an empty area. Colour passed rather than themed, because React
              Flow writes it as an SVG fill attribute, where Chrome does not
              resolve a CSS variable. */}
          <Background gap={24} size={2} color={CANVAS_DOT} />
          {/*
           * One control family, replacing React Flow's own Controls.
           *
           * Its buttons came with their own size, radius, border and hover, and sat
           * in a separate stack in the corner -- so the canvas had two toolbars
           * that looked like they belonged to different applications, and zooming
           * lived in one while everything else lived in the other. These are the
           * app's buttons, in the app's sizes, in one bar.
           */}
          <div className="canvas-tools" role="toolbar" aria-label="Canvas controls">
            <div className="tool-group">
              <button
                className="canvas-tool icon-only"
                aria-label="Zoom out"
                title="Zoom out"
                disabled={zoom <= MIN_ZOOM + 0.001}
                onClick={() => zoomOut({ duration: 0 })}
              >
                <Icon name="minus" />
              </button>
              {/*
               * The zoom level, and the way back to 100%.
               *
               * Worth showing rather than inferring: cards thin to a name and then
               * to a dot as you zoom out (D35), and "the nodes disappeared" is what
               * that looks like without a number to explain it. Pressing it is the
               * reset -- a separate reset button would be a third control for
               * something this one already names.
               */}
              <button
                className="canvas-tool zoom-level"
                title="Reset the zoom to 100%"
                onClick={() => zoomTo(1, { duration: 0 })}
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                className="canvas-tool icon-only"
                aria-label="Zoom in"
                title="Zoom in"
                disabled={zoom >= MAX_ZOOM - 0.001}
                onClick={() => zoomIn({ duration: 0 })}
              >
                <Icon name="plus" />
              </button>
            </div>
            <button
              className="canvas-tool"
              title="Fit the whole tree on screen"
              onClick={() => fitView({ padding: 0.2, maxZoom: 1, duration: 0 })}
            >
              <Icon name="fit" />
              <span>Fit canvas</span>
            </button>
            <CanvasHints />
            {selected?.positionX != null && (
              <button
                className="canvas-tool"
                title="Let the layout place this experiment again"
                onClick={() => onAutomatic(selected.id)}
              >
                <Icon name="automatic" />
                <span>Automatic position</span>
              </button>
            )}
          </div>
        </ReactFlow>
      </BranchContext.Provider>
    </CardActionsContext.Provider>
  );
}
