import { useEffect, useRef } from 'react';
import type { TreeResponse } from '@bonsai/shared';

import type { Address } from './useAddressBar.ts';
import type { Selection } from './selection.ts';

/**
 * Which experiment is selected when a project's tree arrives.
 *
 * The node named in the URL, once -- guarded by a ref rather than by "is
 * nothing selected", which would keep re-selecting it every time the user
 * clicked the canvas background. An id that is not in the tree is simply not
 * selected: a stale link lands you in the right project with nothing chosen,
 * which is recoverable.
 *
 * Then, the first time each project is shown: what the URL asked for, or what
 * was already selected, or the project's root.
 */
export function useRestoredSelection(
  tree: TreeResponse | null,
  selection: Selection,
  arrivedAt: Address,
): void {
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || tree === null || arrivedAt.nodeId === null) return;
    restored.current = true;
    if (tree.nodes.some((n) => n.id === arrivedAt.nodeId)) selection.select(arrivedAt.nodeId);
  }, [tree, arrivedAt.nodeId, selection]);

  const openedProject = useRef<string | null>(null);
  useEffect(() => {
    if (!tree || tree.nodes.length === 0 || openedProject.current === tree.project.id) return;
    openedProject.current = tree.project.id;
    const requested = tree.project.id === arrivedAt.projectId ? arrivedAt.nodeId : null;
    const chosen =
      tree.nodes.find((n) => n.id === requested) ??
      tree.nodes.find((n) => n.id === selection.primary) ??
      tree.nodes.find((n) => n.parentId === null);
    if (chosen) selection.select(chosen.id);
  }, [tree, selection, arrivedAt.projectId, arrivedAt.nodeId]);
}
