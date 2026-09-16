import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  ChangedFile,
  ChangedFilePatchView,
  ChangeScope,
  ChangeSummaryView,
  NodeView,
  RunView,
} from '@bonsai/shared';

import { api } from '../../api/client.ts';
import { describeError } from '../../api/describeError.ts';

/**
 * Change summaries and file patches, fetched where they are shown.
 *
 * The tab and every open window may want the same summary at the same moment
 * -- after a run finishes, all of them refetch. A request made within a couple
 * of seconds of an identical one reuses it, which is all the caching this
 * needs: anything older is fetched again, so reopening the tab is never stale.
 */
const RECENT_MS = 2_000;
const recent = new Map<string, { at: number; promise: Promise<unknown> }>();

function shared<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  for (const [k, entry] of recent) if (now - entry.at > RECENT_MS) recent.delete(k);
  const hit = recent.get(key);
  if (hit !== undefined) return hit.promise as Promise<T>;
  const promise = load();
  recent.set(key, { at: now, promise });
  promise.catch(() => recent.delete(key));
  return promise;
}

export function summaryFor(nodeId: string, scope: ChangeScope): Promise<ChangeSummaryView> {
  return scope.kind === 'run'
    ? shared(`run:${scope.runId}`, () => api.runChanges(scope.runId))
    : shared(`node:${nodeId}`, () => api.nodeChanges(nodeId));
}

/** The files a scope lists: committed ones, or what is not committed yet. */
export function filesIn(summary: ChangeSummaryView, scope: ChangeScope): ChangedFile[] {
  return scope.kind === 'uncommitted' ? summary.uncommitted : summary.files;
}

interface Loaded<T> {
  data: T | null;
  error: string | null;
  retry: () => void;
}

/** Keeps showing the last result while a refetch is in flight, so nothing flickers. */
function useLoaded<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [data, setData] = useState<{ key: string; value: T } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    load()
      .then((value) => alive && setData({ key, value }))
      .catch((e: unknown) => alive && setError(describeError(e)));
    return () => {
      alive = false;
    };
    // `load` is rebuilt every render; `key` says everything it depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { data: data?.value ?? null, error, retry: () => setAttempt((n) => n + 1) };
}

export function useChangeSummary(
  nodeId: string,
  scope: ChangeScope,
  revision: string,
): Loaded<ChangeSummaryView> {
  return useLoaded(
    () => summaryFor(nodeId, scope),
    JSON.stringify([nodeId, scope.kind === 'run' ? scope.runId : 'node', revision]),
  );
}

export function useChangedFile(
  nodeId: string,
  scope: ChangeScope,
  path: string,
  revision: string,
): Loaded<ChangedFilePatchView> {
  const key = JSON.stringify([nodeId, scope, path, revision]);
  return useLoaded(() => shared(`file:${key}`, () => api.changedFile(nodeId, scope, path)), key);
}

/** "All changes", "Run 3", "Uncommitted": what a window's title says it is showing. */
export function scopeLabel(scope: ChangeScope, runs: readonly RunView[]): string {
  if (scope.kind === 'all') return 'All changes';
  if (scope.kind === 'uncommitted') return 'Uncommitted';
  const index = runs.findIndex((run) => run.id === scope.runId);
  return index === -1 ? 'One run' : `Run ${index + 1}`;
}

export function sameScope(a: ChangeScope, b: ChangeScope): boolean {
  return a.kind === b.kind && (a.kind !== 'run' || (b.kind === 'run' && a.runId === b.runId));
}

/**
 * When an experiment's changes may be different: its status, why its last run
 * ended, and its committed totals -- plus anything the panel did to its folder
 * that none of those would show, such as discarding uncommitted files.
 */
let epoch = 0;
const epochListeners = new Set<() => void>();
export function changesMayHaveChanged(): void {
  epoch += 1;
  recent.clear();
  for (const listener of epochListeners) listener();
}

export function useChangeRevision(node: NodeView | null): string {
  const current = useSyncExternalStore(
    (listener) => {
      epochListeners.add(listener);
      return () => {
        epochListeners.delete(listener);
      };
    },
    () => epoch,
    () => epoch,
  );
  return node === null
    ? ''
    : JSON.stringify([node.status, node.lastRunEndReason, node.diffStat, current]);
}
