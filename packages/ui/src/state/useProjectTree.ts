import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeResponse } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { deletionMessage } from './deletionMessage.ts';

/**
 * Long enough to swallow the three events one finished run produces, short
 * enough that a card's status still looks immediate.
 */
const REFETCH_DEBOUNCE_MS = 120;

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
export function useProjectTree(
  onError: (message: string) => void,
  /** Preferred on first load, usually from the URL. Ignored if it is unknown. */
  preferredId?: string | null,
): {
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

  /**
   * Coalesces refetches that arrive together.
   *
   * Every status change and every finished run asks for the whole tree, which
   * is invisible at five nodes and a storm at a hundred with four agents
   * running: a single run produces `node.status`, `run.finished` and
   * `tree.updated` within milliseconds of each other, so three identical
   * requests race and the last one wins anyway.
   *
   * The server stays the source of truth (PRD §9 constraint 3) — this refetches
   * exactly as before, just fewer times. Nothing here mutates a local tree.
   *
   * A trailing debounce, not a leading one: the interesting state is the one
   * after the burst settles, and firing on the first event would show the tree
   * as it was mid-change and then need another fetch anyway.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null);

  const loadSoon = useCallback(
    (id: string): void => {
      pending.current = id;
      if (timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const wanted = pending.current;
        pending.current = null;
        if (wanted !== null) void load(wanted);
      }, REFETCH_DEBOUNCE_MS);
    },
    [load],
  );

  // A pending refetch must not fire into an unmounted component, or into a
  // project the user has since left.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      pending.current = null;
    },
    [],
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
        if (ps.length === 0) {
          setNoProjects(true);
          return;
        }
        // A project id from the URL wins, but only if it still exists. A
        // stale bookmark opens the newest project rather than an error page:
        // the id may have been deleted, and there is nothing useful to say
        // about that which is better than showing them their work.
        const wanted = ps.find((p) => p.id === preferredId);
        const chosen = wanted ?? ps[0]!;
        setProjectId(chosen.id);
        return load(chosen.id);
      })
      .catch((e: unknown) => onError(String(e)));
    // Once, on mount. `open` is deliberately not a dependency: this decides
    // which project to start on, and re-running it would yank the user back to
    // the first one every time the callback identity changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = useCallback((): void => {
    if (projectId !== null) loadSoon(projectId);
  }, [projectId, loadSoon]);

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
