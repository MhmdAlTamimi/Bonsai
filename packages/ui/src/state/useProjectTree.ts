import { useCallback, useEffect, useRef, useState } from 'react';
import type { TreeResponse } from '@bonsai/shared';

import { api } from '../api/client.ts';
import { describeError } from '../api/describeError.ts';
import type { ConfirmRequest } from '../ConfirmDialog.tsx';
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
  /** Asks the user to confirm something destructive. See ConfirmDialog. */
  confirm: (request: ConfirmRequest) => Promise<boolean>,
  /** Preferred on first load, usually from the URL. Missing projects are reported explicitly. */
  preferredId?: string | null,
): {
  projects: ProjectSummary[];
  projectId: string | null;
  tree: TreeResponse | null;
  /** True once the first load has finished and found nothing. */
  noProjects: boolean;
  loading: boolean;
  error: string | null;
  retry: () => void;
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

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async (id: string): Promise<void> => {
    if (id !== current.current) return;
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const value = await api.tree(id);
      if (ticket === request.current && id === current.current) setTree(value);
    } catch (e) {
      if (ticket === request.current && id === current.current) setError(describeError(e));
    } finally {
      if (ticket === request.current && id === current.current) setLoading(false);
    }
  }, []);

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
      current.current = id;
      request.current += 1;
      setTree(null);
      pending.current = null;
      setProjectId(id);
      setNoProjects(false);
      void load(id);
    },
    [load],
  );

  const loadProjects = useCallback((): void => {
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    void api
      .listProjects()
      .then((ps) => {
        if (ticket !== request.current) return;
        setProjects(ps);
        if (preferredId != null && !ps.some((p) => p.id === preferredId)) {
          setError('This project is unavailable. Choose a project from the Project menu.');
          setLoading(false);
          return;
        }
        if (ps.length === 0) {
          setNoProjects(true);
          setLoading(false);
          return;
        }
        open(preferredId ?? ps[0]!.id);
      })
      .catch((e: unknown) => {
        if (ticket === request.current) {
          setError(describeError(e));
          setLoading(false);
        }
      });
  }, [open, preferredId]);
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const refresh = useCallback((): void => {
    if (projectId !== null) loadSoon(projectId);
  }, [projectId, loadSoon]);

  const adopted = useCallback(
    (id: string): void => {
      open(id);
      void api
        .listProjects()
        .then(setProjects)
        .catch((e: unknown) => onError(describeError(e)));
    },
    [open, onError],
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
    /**
     * Typing the name, deliberately. Deleting a project cascades to every node,
     * destroys runs that cost money and cannot be reproduced, and -- for a
     * project Bonsai created -- removes a directory from disk. A button you can
     * hit by reflex is not consent to that.
     */
    const ok = await confirm({
      title: `Delete project "${tree.project.name}"?`,
      body: deletionMessage(impact),
      confirmLabel: 'Delete project',
      danger: true,
      requireText: tree.project.name,
    });
    if (!ok) return;

    await api.deleteProject(projectId);
    const remaining = await api.listProjects();
    setProjects(remaining);
    const next = remaining[0];
    if (next === undefined) {
      setTree(null);
      current.current = null;
      request.current += 1;
      setProjectId(null);
      setNoProjects(true);
    } else {
      open(next.id);
    }
  }, [tree, projectId, open, onError, confirm]);

  const close = useCallback((): void => {
    setNoProjects(false);
  }, []);

  return {
    projects,
    projectId,
    tree,
    noProjects,
    loading,
    error,
    retry: () => (current.current === null ? loadProjects() : void load(current.current)),
    open,
    refresh,
    adopted,
    deleteCurrent,
    close,
  };
}
