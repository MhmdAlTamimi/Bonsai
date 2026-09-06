import dagre from '@dagrejs/dagre';
import type { NodeView } from '@bonsai/shared';
import type { Edge, Node } from 'reactflow';
import { codeState } from '../nodeCode.ts';

export const CARD_WIDTH = 220;
export const CARD_HEIGHT = 76;

/**
 * Layout direction. D35 specifies left-to-right; this is top-to-bottom by
 * preference, which PRD §9 explicitly allows -- the five structural constraints
 * are fixed, everything visual is not. D35's argument was against *radial*
 * (it degrades on deep chains), and a top-to-bottom rank layout is not radial,
 * so the reasoning still holds either way.
 *
 * One knob, so flipping back is one word. NodeCard reads it too, to put its
 * connection handles on the matching edges.
 */
export const RANK_DIR: 'TB' | 'LR' = 'TB';

/**
 * PRD §9: positions are nullable and auto-layout is the default. A node that
 * has been dragged carries its own position and is pinned there; everything
 * else is laid out by dagre.
 */
export function layoutTree(nodes: readonly NodeView[]): { nodes: Node[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  // In TB, nodesep is the horizontal gap between siblings and ranksep the
  // vertical gap between generations; in LR the two swap roles, so the numbers
  // differ per direction rather than being shared.
  graph.setGraph(
    RANK_DIR === 'TB'
      ? { rankdir: 'TB', nodesep: 26, ranksep: 58, marginx: 40, marginy: 40 }
      : { rankdir: 'LR', nodesep: 28, ranksep: 90, marginx: 40, marginy: 40 },
  );
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
      // An edge into a node that ran and wrote nothing carries conversation but
      // no code. Drawing that distinction is the whole point of the tree -- but
      // only once the run has finished and the answer is actually known.
      style:
        codeState(n) === 'none'
          ? { stroke: 'var(--edge-dim)', strokeWidth: 1.5, strokeDasharray: '4 4' }
          : { stroke: 'var(--edge)', strokeWidth: 1.5 },
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
