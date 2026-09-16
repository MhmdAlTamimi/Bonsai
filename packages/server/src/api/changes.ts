import type {
  ChangedFile,
  ChangedFilePatchView,
  ChangeScope,
  ChangeSummaryView,
} from '@bonsai/shared';

import { isUsersOwnCheckout, type NodeRow, type Store } from '../db/store.js';
import { parentSnapshot } from '../git/diff.js';
import {
  committedChanges,
  committedFilePatch,
  totalsOf,
  uncommittedChanges,
  uncommittedFilePatch,
} from '../git/changes.js';
import { HttpError } from './http.js';

/**
 * Which changes are being asked about, resolved once, for the summary routes
 * and the single-file route alike -- so a file can only be opened from a
 * change it is actually part of.
 */

/**
 * The two commits an experiment's whole change sits between, or null when it
 * has committed nothing.
 *
 * A child's base is pinned when it is created. Master has none: its change
 * starts at the commit before its first committing run.
 */
export async function experimentRange(
  store: Store,
  row: NodeRow,
): Promise<{ base: string; head: string } | null> {
  const first = store.listRuns(row.id).find((run) => run.commitSha !== null);
  const base =
    row.base_commit ??
    (first?.commitSha != null
      ? await parentSnapshot(row.worktree_path, first.commitSha)
      : row.head_commit);
  if (base === null) return null;
  const hasCommits = row.parent_id === null ? first !== undefined : row.head_commit !== null;
  return hasCommits ? { base, head: row.head_commit ?? base } : null;
}

export function experimentBaseLabel(store: Store, row: NodeRow): string {
  return row.parent_id === null
    ? 'The code before this experiment’s first modifying run'
    : `The inherited code snapshot from ${store.lineageOf(row).codeFrom?.displayName ?? 'its source experiment'}`;
}

export async function experimentChanges(store: Store, row: NodeRow): Promise<ChangeSummaryView> {
  const range = await experimentRange(store, row);
  const files =
    range === null ? [] : await committedChanges(row.worktree_path, range.base, range.head);
  const ownFolder = isUsersOwnCheckout(store.getProject(row.project_id), row);
  return {
    scope: 'all',
    runId: null,
    baseLabel: experimentBaseLabel(store, row),
    totals: totalsOf(files),
    files,
    uncommitted: ownFolder ? [] : await uncommittedChanges(row.worktree_path),
  };
}

/** One run's own commit, against the commit before it. */
export async function runChanges(
  store: Store,
  runId: string,
): Promise<{
  summary: ChangeSummaryView;
  row: NodeRow;
  range: { base: string; head: string } | null;
}> {
  const run = store.getRun(runId);
  if (run === undefined) throw new HttpError(404, 'no such run');
  const row = store.getNode(run.node_id);
  if (row === undefined) throw new HttpError(404, 'no such node');
  const range =
    run.commit_sha === null
      ? null
      : { base: await parentSnapshot(row.worktree_path, run.commit_sha), head: run.commit_sha };
  const files =
    range === null ? [] : await committedChanges(row.worktree_path, range.base, range.head);
  return {
    row,
    range,
    summary: {
      scope: 'run',
      runId,
      baseLabel: 'The code just before this run',
      totals: totalsOf(files),
      files,
      uncommitted: [],
    },
  };
}

/**
 * One file's patch, from the change it belongs to.
 *
 * The path must be in that change's own summary. Checked by lookup rather
 * than by sanitising the string: a path that is not in the list cannot reach
 * git at all, so there is nothing to get wrong about `..` or leading dashes.
 */
export async function changedFilePatch(
  store: Store,
  row: NodeRow,
  scope: ChangeScope,
  path: string,
): Promise<ChangedFilePatchView> {
  const find = (files: readonly ChangedFile[]): ChangedFile => {
    const file = files.find((f) => f.path === path);
    if (file === undefined) throw new HttpError(404, 'That file is not part of these changes.');
    return file;
  };

  if (scope.kind === 'uncommitted') {
    if (isUsersOwnCheckout(store.getProject(row.project_id), row)) {
      throw new HttpError(404, 'That file is not part of these changes.');
    }
    const file = find(await uncommittedChanges(row.worktree_path));
    return { file, ...(await uncommittedFilePatch(row.worktree_path, file)) };
  }

  if (scope.kind === 'run') {
    const { row: owner, range, summary } = await runChanges(store, scope.runId);
    if (owner.id !== row.id) throw new HttpError(404, 'no such run in this experiment');
    const file = find(summary.files);
    return {
      file,
      ...(await committedFilePatch(row.worktree_path, range!.base, range!.head, file)),
    };
  }

  const range = await experimentRange(store, row);
  if (range === null) throw new HttpError(404, 'That file is not part of these changes.');
  const file = find(await committedChanges(row.worktree_path, range.base, range.head));
  return { file, ...(await committedFilePatch(row.worktree_path, range.base, range.head, file)) };
}
