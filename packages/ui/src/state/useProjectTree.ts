import { useCallback, useEffect, useState } from 'react';
import type { TreeResponse } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { deletionMessage } from './deletionMessage.ts';

export interface ProjectSummary {
  id: string;
  name: string;
}

/**
 * The open project and its tree.
 *
 * PRD §9 constraint 3: the backend is the source of truth. Every mutation
 * refetches; nothing here edits a local tree and hopes the server agrees.
 * Keep it that way — an optimistic tree would have to reimplement the
 * lineage rules the server already owns, and would be wrong the first time
 * they disagreed.
 */
export function useProjectTree(onError: (message: string) => void): {
  projects: ProjectSummary[];
  projectId: string | null;
  tree: TreeResponse | null;
  /** True once the first load has finished and found nothing. */
  noProjects: boolean;
  open: (id: string) => void;
  refresh: () => void;
  /** After creating or adopting: switch to it and pick up the new list. */
  adopted: (id: string) => void;
  /** Confirms, deletes, and moves to whatever is left. */
  deleteCurrent: () => Promise<void>;
  close: () => void;
} {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [noProjects, setNoProjects] = useState(false);

  const load = useCallback(
    async (id: string): Promise<void> => {
      try {
        setTree(await api.tree(id));
      } catch (e) {
        onError(String(e));
      }
    },
    [onError],
  );

  const open = useCallback(
    (id: string): void => {
      setProjectId(id);
      setNoProjects(false);
      void load(id);
    },
    [load],
  );

  useEffect(() => {
    void api
      .listProjects()
      .then((ps) => {
        setProjects(ps);
        const first = ps[0];
        if (first === undefined) {
          setNoProjects(true);
          return;
        }
        setProjectId(first.id);
        return load(first.id);
      })
      .catch((e: unknown) => onError(String(e)));
    // Once, on mount. `open` is deliberately not a dependency: this decides
    // which project to start on, and re-running it would yank the user back to
    // the first one every time the callback identity changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback((): void => {
    if (projectId !== null) void load(projectId);
  }, [projectId, load]);

  const adopted = useCallback(
    (id: string): void => {
      open(id);
      void api.listProjects().then(setProjects);
    },
    [open],
  );

  /**
   * D7 cascades and B9 (soft delete) is deferred, so this is irreversible and
   * destroys paid, unreproducible work. Saying how much before asking is the
   * cheap part of B9 worth having now.
   */
  const deleteCurrent = useCallback(async (): Promise<void> => {
    if (tree === null || projectId === null) return;

    const impact = await api.projectDeletionImpact(projectId).catch(() => null);
    if (impact === null) {
      onError('Could not work out what deleting this would remove, so nothing was deleted.');
      return;
    }
    if (!window.confirm(deletionMessage(tree.project.name, impact))) return;

    await api.deleteProject(projectId);
    const remaining = await api.listProjects();
    setProjects(remaining);
    const next = remaining[0];
    if (next === undefined) {
      setTree(null);
      setProjectId(null);
      setNoProjects(true);
    } else {
      open(next.id);
    }
  }, [tree, projectId, open, onError]);

  const close = useCallback((): void => {
    setNoProjects(false);
  }, []);

  return { projects, projectId, tree, noProjects, open, refresh, adopted, deleteCurrent, close };
}
