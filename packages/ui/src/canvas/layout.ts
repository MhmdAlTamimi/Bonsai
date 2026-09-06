import dagre from '@dagrejs/dagre';
import type { NodeView } from '@bonsai/shared';
import type { Edge, Node } from 'reactflow';

export const CARD_WIDTH = 220;
export const CARD_HEIGHT = 76;

/**
 * D35: left-to-right auto-layout. Radial degrades badly on deep chains, and
 * depth is the normal case here.
 *
 * PRD §9: positions are nullable and auto-layout is the default. A node that
 * has been dragged carries its own position and is pinned there; everything
 * else is laid out by dagre.
 */
export function layoutTree(nodes: readonly NodeView[]): { nodes: Node[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 90, marginx: 40, marginy: 40 });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const n of nodes) graph.setNode(n.id, { width: CARD_WIDTH, height: CARD_HEIGHT });

  const edges: Edge[] = [];
  for (const n of nodes) {
    if (n.parentId === null) continue;
    graph.setEdge(n.parentId, n.id);
    edges.push({
      id: `${n.parentId}->${n.id}`,
      source: n.parentId,
      target: n.id,
      type: 'smoothstep',
      // An edge into a node with no commits carries conversation but no code.
      // Drawing that distinction is the whole point of the tree.
      style: n.hasCommits
        ? { stroke: 'var(--edge)', strokeWidth: 1.5 }
        : { stroke: 'var(--edge-dim)', strokeWidth: 1.5, strokeDasharray: '4 4' },
    });
  }

  dagre.layout(graph);

  return {
    nodes: nodes.map((n) => {
      const laid = graph.node(n.id) as { x: number; y: number } | undefined;
      const x = n.positionX ?? (laid?.x ?? 0) - CARD_WIDTH / 2;
      const y = n.positionY ?? (laid?.y ?? 0) - CARD_HEIGHT / 2;
      return {
        id: n.id,
        type: 'bonsai',
        position: { x, y },
        data: n,
        draggable: true,
      } satisfies Node;
    }),
    edges,
  };
}
