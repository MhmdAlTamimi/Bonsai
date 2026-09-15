import { type JSX, useRef } from 'react';
import ReactFlow, { Background, Controls, type NodeMouseHandler, useReactFlow } from 'reactflow';
import 'reactflow/dist/style.css';
import type { NodeView } from '@bonsai/shared';

import { Icon } from '../Icon.tsx';

import { CanvasHints } from './CanvasHints.tsx';
import { NodeCard } from './NodeCard.tsx';
import { useLaidOutNodes } from './useLaidOutNodes.ts';

const nodeTypes = { bonsai: NodeCard };

export interface DropTarget {
  parentId: string;
  parentName: string;
  position: { x: number; y: number };
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
  onDropOnPane,
  onAutomatic,
}: {
  nodes: readonly NodeView[];
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  onToggleSelect: (nodeId: string) => void;
  onAutomatic: (nodeId: string) => void;
  onMoved: (nodeId: string, position: { x: number; y: number }) => void;
  /** A drag out of a node's handle, released over empty canvas. */
  onDropOnPane: (target: DropTarget) => void;
}): JSX.Element {
  const selected = nodes.find((node) => node.id === selectedId);
  const { flowNodes, edges, onNodesChange } = useLaidOutNodes(nodes, selectedId);

  // Behind a ref for the same reason fitView is: useReactFlow() hands back a
  // new identity whenever the viewport moves.
  const { screenToFlowPosition, fitView } = useReactFlow();
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

    onDropOnPane({
      parentId,
      parentName: nodes.find((n) => n.id === parentId)?.displayName ?? 'this node',
      position: screenToFlowRef.current({ x: point.clientX, y: point.clientY }),
    });
  };

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onConnectStart={(_event, params: { nodeId: string | null }) => {
        dragSource.current = params.nodeId;
      }}
      onConnectEnd={onConnectEnd}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onNodeDragStop={(_event, node) => onMoved(node.id, node.position)}
      // Deliberately NOT clearing the selection on a pane click. The panel
      // is the primary workspace (§7), and emptying it because a click
      // landed between two cards loses your place for no gain -- selecting
      // another node replaces it anyway.
      minZoom={0.25}
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
        }
      }}
      maxZoom={1.8}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} showFitView={false} />
      <div className="canvas-tools">
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
  );
}
