import dagre from '@dagrejs/dagre';
import type { NodeView } from '@bonsai/shared';

/** The card's drawn size, kept in step with `.card` in styles/canvas.css. */
export const CARD_WIDTH = 248;
export const CARD_HEIGHT = 122;

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

export type LayoutNode = Pick<NodeView, 'id' | 'parentId' | 'positionX' | 'positionY'>;

/** Geometry is independent of run status, names and conversation updates. */
export function layoutPositions(
  nodes: readonly LayoutNode[],
  sizes: ReadonlyMap<string, { width: number; height: number }> = new Map(),
): Map<string, { x: number; y: number }> {
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

  for (const n of nodes)
    graph.setNode(n.id, sizes.get(n.id) ?? { width: CARD_WIDTH, height: CARD_HEIGHT });

  for (const node of nodes) if (node.parentId !== null) graph.setEdge(node.parentId, node.id);
  dagre.layout(graph);
  return new Map(
    nodes.map((node) => {
      const laid = graph.node(node.id) as { x: number; y: number } | undefined;
      const size = sizes.get(node.id) ?? { width: CARD_WIDTH, height: CARD_HEIGHT };
      return [
        node.id,
        {
          x: node.positionX ?? (laid?.x ?? 0) - size.width / 2,
          y: node.positionY ?? (laid?.y ?? 0) - size.height / 2,
        },
      ];
    }),
  );
}
