import type { TreeResponse } from '@bonsai/shared';

/** Preserve identity for unchanged server records, without optimistic edits. */
export function reconcileTree(previous: TreeResponse | null, next: TreeResponse): TreeResponse {
  if (previous?.project.id !== next.project.id) return next;
  const byId = new Map(previous.nodes.map((node) => [node.id, node]));
  const nodes = next.nodes.map((node) => {
    const before = byId.get(node.id);
    return before && JSON.stringify(before) === JSON.stringify(node) ? before : node;
  });
  const unchanged =
    nodes.length === previous.nodes.length && nodes.every((node, i) => node === previous.nodes[i]);
  const project =
    JSON.stringify(previous.project) === JSON.stringify(next.project)
      ? previous.project
      : next.project;
  return unchanged && project === previous.project
    ? previous
    : { ...next, project, nodes: unchanged ? previous.nodes : nodes };
}
