import { useEffect, useMemo, useRef } from 'react';
import { type Edge, type Node, useNodesState, useReactFlow } from 'reactflow';
import type { NodeView } from '@bonsai/shared';

import { layoutTree } from './layout.ts';

/**
 * Server state, turned into nodes React Flow will actually draw.
 *
 * This is its own file because it is the most fragile code in the interface:
 * both halves look like they could be simplified away and both were bugs when
 * they were missing. If you are here to tidy something, read the two comments
 * below first.
 */
export function useLaidOutNodes(
  nodes: readonly NodeView[],
  selectedId: string | null,
): {
  flowNodes: Array<Node<NodeView>>;
  edges: Edge[];
  onNodesChange: ReturnType<typeof useNodesState<NodeView>>[2];
} {
  /**
   * React Flow owns the node array; we merge server state into it.
   *
   * This is the fix for the canvas going blank after a refresh — reported for
   * changing the model, for chatting, and earlier for creating a node, because
   * all three end in a refetch.
   *
   * React Flow hides a node it has not measured (`visibility: hidden`) and
   * reports the measurement back through onNodesChange. That handler was never
   * wired, so the measurements had nowhere to land: every refetch replaced the
   * array with freshly-built nodes that looked unmeasured, and every node was
   * hidden until re-measured. Locally that is milliseconds; with more nodes or
   * a slower machine the canvas just looks empty until a zoom forces a
   * re-measure. "Zoom in and out to get it back" was the tell.
   *
   * useNodesState keeps the applyNodeChanges plumbing, so dimensions persist,
   * and merging by id below preserves them across refetches. The end-to-end
   * test asserts a card is never invisible across a refetch, and fails if
   * either half of this goes.
   */
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<NodeView>([]);

  const edges = useMemo(() => layoutTree(nodes).edges, [nodes]);

  useEffect(() => {
    const laid = layoutTree(nodes);
    setFlowNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      return laid.nodes.map((fresh) => {
        const previous = byId.get(fresh.id);
        /**
         * `selected` is set from OUR selection, not React Flow's.
         *
         * Bonsai keeps selection in its own store (it is a list, per PRD §9),
         * and React Flow's internal selection was never told about it -- so
         * the prop the card reads was permanently false and the canvas gave no
         * hint which of twenty nodes the panel was showing.
         */
        const marked = { ...fresh, selected: fresh.id === selectedId };
        // Keep the measured node and overlay only what the server changed.
        return previous === undefined
          ? marked
          : {
              ...previous,
              data: marked.data,
              position: marked.position,
              selected: marked.selected,
            };
      });
    });
  }, [nodes, selectedId, setFlowNodes]);

  /**
   * Refit when the tree grows. Not cosmetic: the layout extends downward, so
   * without this a newly created node lands outside the viewport and cannot be
   * reached at all until you hit the fit control by hand.
   *
   * Two loops to avoid if you touch this. useReactFlow() returns a fresh
   * `fitView` identity whenever the viewport changes, so depending on it makes
   * every fit schedule the next one -- hence the ref. And gating on
   * useNodesInitialized() loops too: fitting changes the zoom, the zoom changes
   * each card's level of detail, that changes the card's size, and React Flow
   * re-measures. A plain timer avoids both.
   *
   * maxZoom stops a single small node from being blown up to fill the screen.
   */
  const { fitView } = useReactFlow();
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;
  const nodeCount = flowNodes.length;
  useEffect(() => {
    if (nodeCount === 0) return;
    const timer = setTimeout(
      () => fitViewRef.current({ duration: 250, padding: 0.2, maxZoom: 1 }),
      120,
    );
    return () => clearTimeout(timer);
  }, [nodeCount]);

  return { flowNodes, edges, onNodesChange };
}
