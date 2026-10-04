import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  type Edge,
  type Node,
  useNodesState,
  useReactFlow,
  useNodesInitialized,
  useStore,
} from 'reactflow';
import type { NodeView } from '@bonsai/shared';

import { layoutPositions, type LayoutNode } from './layout.ts';
import { codeState } from '../nodeCode.ts';

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
  const [flowNodes, setFlowNodes, applyChanges] = useNodesState<NodeView>([]);
  const onNodesChange = useCallback<typeof applyChanges>(
    (changes) => applyChanges(changes.filter((change) => change.type !== 'select')),
    [applyChanges],
  );

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
  const structure = JSON.stringify(
    nodes.map(({ id, parentId, positionX, positionY }) => ({ id, parentId, positionX, positionY })),
  );
  // Only topology, pinned coordinates and measured dimensions require Dagre.
  const positions = useMemo(
    () => layoutPositions(JSON.parse(structure) as LayoutNode[], sizes),
    [structure, sizes],
  );
  const edges = useMemo(() => {
    const path = new Set<string>();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let current = selectedId;
    while (current !== null && !path.has(current)) {
      path.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    return nodes
      .filter((node) => node.parentId !== null)
      .map((node) => ({
        id: `${node.parentId}->${node.id}`,
        source: node.parentId!,
        target: node.id,
        type: 'bonsai',
        data: {
          conversationOnly: codeState(node) === 'none',
          live: path.has(node.id) && path.has(node.parentId!),
        },
        ariaLabel: `Conversation from ${byId.get(node.parentId!)?.displayName ?? 'source'} to ${node.displayName}`,
      }));
  }, [nodes, selectedId]);

  useLayoutEffect(() => {
    setFlowNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]));
      const next = nodes.map((record) => {
        const fresh = {
          id: record.id,
          type: 'bonsai',
          draggable: true,
          position: positions.get(record.id)!,
        };
        const previous = byId.get(fresh.id);
        /**
         * `selected` is set from OUR selection, not React Flow's.
         *
         * Bonsai keeps selection in its own store (it is a list, per PRD §9),
         * and React Flow's internal selection was never told about it -- so
         * the prop the card reads was permanently false and the canvas gave no
         * hint which of twenty nodes the panel was showing.
         */
        if (
          previous?.data === record &&
          previous.selected === (fresh.id === selectedId) &&
          previous.position.x === fresh.position.x &&
          previous.position.y === fresh.position.y
        )
          return previous;
        const marked = {
          ...fresh,
          data: record,
          ariaLabel: `Experiment ${record.displayName}`,
          selected: fresh.id === selectedId,
        };
        // Keep the measured node and overlay only what the server changed.
        return previous === undefined
          ? marked
          : {
              ...previous,
              ...marked,
            };
      });
      return next.length === current.length && next.every((node, i) => node === current[i])
        ? current
        : next;
    });
  }, [positions, nodes, selectedId, setFlowNodes]);

  // Open the selected experiment at readable scale once per project. Later selection reveals only offscreen nodes, without changing zoom.
  const flow = useReactFlow();
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const fitted = useRef(false);
  const revealedSelection = useRef<string | null>(null);
  const initialized = useNodesInitialized();
  const viewportWidth = useStore((state) => state.width);
  const viewportHeight = useStore((state) => state.height);
  const canvas = useStore((state) => state.domNode);
  const count = flowNodes.length;
  useEffect(() => {
    // Run after React Flow attaches its zoom handlers, so the center updates
    // both the D3 transform and React Flow's rendered viewport.
    // setCenter is a no-op before the viewport initializes. A hidden canvas
    // also gets React Flow's 500px fallback size; neither is a completed fit.
    if (
      !initialized ||
      !flow.viewportInitialized ||
      count === 0 ||
      fitted.current ||
      !canvas ||
      canvas.clientWidth === 0 ||
      canvas.clientHeight === 0 ||
      canvas.clientWidth !== viewportWidth ||
      canvas.clientHeight !== viewportHeight ||
      sizes.size !== count
    )
      return;
    const chosen =
      flowNodes.find((node) => node.id === selectedId) ??
      flowNodes.find((node) => node.data.parentId === null);
    if (!chosen) return;
    const point = positions.get(chosen.id) ?? chosen.position;
    // Wait for the measured layout to reach the rendered node array too.
    if (chosen.position.x !== point.x || chosen.position.y !== point.y) return;
    void flowRef.current.setCenter(
      point.x + (chosen.width ?? 248) / 2,
      point.y + (chosen.height ?? 122) / 2,
      { zoom: 1, duration: 0 },
    );
    fitted.current = true;
    // setCenter schedules a D3 transition, even with duration 0. Do not let
    // selection reveal replace it using the previous viewport.
    revealedSelection.current = selectedId;
  }, [
    count,
    initialized,
    flow.viewportInitialized,
    canvas,
    viewportWidth,
    viewportHeight,
    sizes,
    flowNodes,
    positions,
    selectedId,
  ]);
  useEffect(() => {
    if (!selectedId || !fitted.current || !initialized || revealedSelection.current === selectedId)
      return;
    const node = flowRef.current.getNode(selectedId);
    const element = document.querySelector<HTMLElement>('.react-flow');
    if (!node || !element || element.clientWidth === 0) return;
    revealedSelection.current = selectedId;
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
  }, [selectedId, count, initialized]);
  return { flowNodes, edges, onNodesChange };
}
