import type { ReviewFilePatchView, ReviewView } from '@bonsai/shared';

import type { NodeRow, Store } from '../db/store.js';
import { parentSnapshot } from '../git/diff.js';
import { reviewFileContent, reviewFilePatch, reviewFiles, totalsOf } from '../git/review.js';
import { HttpError } from './http.js';

/**
 * The two commits an experiment's change sits between, or null when it has
 * committed nothing and everything it did is still in its folder.
 *
 * A child's base is pinned when it is created. Master has none: its change
 * starts at the commit before its first committing run.
 */
export async function reviewRange(
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

export function baseLabel(store: Store, row: NodeRow): string {
  return row.parent_id === null
    ? 'the code before this experiment’s first modifying run'
    : `the inherited code snapshot from ${store.lineageOf(row).codeFrom?.displayName ?? 'its source experiment'}`;
}

export async function reviewOf(store: Store, row: NodeRow): Promise<ReviewView> {
  const files = await reviewFiles(row.worktree_path, await reviewRange(store, row));
  return {
    nodeId: row.id,
    displayName: row.display_name,
    baseLabel: baseLabel(store, row),
    totals: totalsOf(files),
    files,
  };
}

/**
 * One file's patch, for the pane reading it.
 *
 * The path must be one this experiment actually changed. Checked by lookup
 * rather than by sanitising the string: a path that is not in the list cannot
 * reach git at all, so there is nothing to get wrong about `..` or a leading
 * dash.
 */
export async function reviewPatchOf(
  store: Store,
  row: NodeRow,
  path: string,
  fullFile = false,
): Promise<ReviewFilePatchView> {
  const range = await reviewRange(store, row);
  const file = (await reviewFiles(row.worktree_path, range)).find((f) => f.path === path);
  if (file === undefined) throw new HttpError(404, 'This experiment did not change that file.');
  if (fullFile)
    return {
      file,
      patch: '',
      ...(file.binary
        ? { content: '', truncated: false }
        : await reviewFileContent(row.worktree_path, range, file)),
    };
  return { file, ...(await reviewFilePatch(row.worktree_path, range, file)) };
}
