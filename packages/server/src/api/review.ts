import type { ReviewFilePatchView, ReviewView } from '@bonsai/shared';

import type { NodeRow, Store } from '../db/store.js';
import { contextFileAt, readContextFile } from '../git/context.js';
import { parentSnapshot } from '../git/diff.js';
import {
  reviewFileContent,
  reviewFilePatch,
  reviewFiles,
  totalsOf,
  type ReviewSource,
} from '../git/review.js';
import { HttpError } from './http.js';

/**
 * Where an experiment's changes are read: its folder, or the repository once
 * the folder is archived. Null when it has never had a folder.
 */
export function reviewSource(store: Store, row: NodeRow): ReviewSource | null {
  if (row.worktree_allocated !== 0) return { cwd: row.worktree_path, committedOnly: false };
  if (row.archived_at === null) return null;
  const project = store.getProject(row.project_id);
  return project === undefined ? null : { cwd: project.repo_path, committedOnly: true };
}

/**
 * An experiment's CONTEXT.md, and where its history can be read: the folder,
 * or -- once it is archived -- the repository at the experiment's last commit.
 */
export async function experimentNotes(
  store: Store,
  row: NodeRow,
): Promise<{ contextMd: string | null; cwd: string; head: string }> {
  const source = reviewSource(store, row);
  const head = row.head_commit ?? row.base_commit;
  if (source?.committedOnly !== true || head === null)
    return {
      contextMd: await readContextFile(row.worktree_path),
      cwd: row.worktree_path,
      head: 'HEAD',
    };
  return { contextMd: await contextFileAt(source.cwd, head), cwd: source.cwd, head };
}

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
      ? await parentSnapshot(reviewSource(store, row)?.cwd ?? row.worktree_path, first.commitSha)
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
  const source = reviewSource(store, row);
  const files = source === null ? [] : await reviewFiles(source, await reviewRange(store, row));
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
  const source = reviewSource(store, row);
  if (source === null) throw new HttpError(404, 'This experiment has not created a checkout yet.');
  const range = await reviewRange(store, row);
  const file = (await reviewFiles(source, range)).find((f) => f.path === path);
  if (file === undefined) throw new HttpError(404, 'This experiment did not change that file.');
  if (fullFile)
    return {
      file,
      patch: '',
      ...(file.binary
        ? { content: '', truncated: false }
        : await reviewFileContent(source, range, file)),
    };
  return { file, ...(await reviewFilePatch(source, range, file)) };
}
