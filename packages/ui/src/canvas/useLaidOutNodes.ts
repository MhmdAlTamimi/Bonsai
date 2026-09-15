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

  const geometry = JSON.stringify(
    flowNodes
      .filter((node) => node.width && node.height)
      .map((node) => [node.id, node.width, node.height]),
  );
  const sizes = useMemo(
    () =>
      new Map(
        (JSON.parse(geometry) as Array<[string, number, number]>).map(([id, width, height]) => [
          id,
          { width, height },
        ]),
      ),
    [geometry],
  );
  const laid = useMemo(() => layoutTree(nodes, sizes), [nodes, sizes]);
  const edges = useMemo(() => {
    const path = new Set<string>();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let current = selectedId;
    while (current !== null && !path.has(current)) {
      path.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    return laid.edges.map((edge) => ({
      ...edge,
      style: {
        ...edge.style,
        ...(path.has(edge.target) && path.has(edge.source)
          ? { stroke: 'var(--focus)', strokeWidth: 2.5 }
          : {}),
      },
    }));
  }, [laid, nodes, selectedId]);

  useEffect(() => {
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
              ...marked,
            };
      });
    });
  }, [laid, selectedId, setFlowNodes]);

  // Fit once for a project. Later selection reveals only offscreen nodes, without changing zoom.
  const flow = useReactFlow();
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const fitted = useRef(false);
  const count = flowNodes.length;
  useEffect(() => {
    if (count === 0 || fitted.current) return;
    const timer = setTimeout(() => {
      flowRef.current.fitView({ padding: 0.2, maxZoom: 1, duration: 0 });
      fitted.current = true;
    }, 120);
    return () => clearTimeout(timer);
  }, [count]);
  useEffect(() => {
    if (!selectedId || !fitted.current) return;
    const timer = setTimeout(() => {
      const node = flowRef.current.getNode(selectedId);
      const element = document.querySelector<HTMLElement>('.react-flow');
      if (!node || !element || element.clientWidth === 0) return;
      const viewport = flowRef.current.getViewport();
      const left = node.position.x * viewport.zoom + viewport.x;
      const top = node.position.y * viewport.zoom + viewport.y;
      const width = (node.width ?? 260) * viewport.zoom;
      const height = (node.height ?? 138) * viewport.zoom;
      const dx =
        left < 30
          ? 30 - left
          : left + width > element.clientWidth - 30
            ? element.clientWidth - 30 - left - width
            : 0;
      const dy =
        top < 100
          ? 100 - top
          : top + height > element.clientHeight - 70
            ? element.clientHeight - 70 - top - height
            : 0;
      if (dx || dy)
        flowRef.current.setViewport(
          { ...viewport, x: viewport.x + dx, y: viewport.y + dy },
          { duration: 0 },
        );
    }, 160);
    return () => clearTimeout(timer);
  }, [selectedId, count]);
  return { flowNodes, edges, onNodesChange };
}
