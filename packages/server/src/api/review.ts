import type { ChangeScope, ReviewFilePatchView, ReviewView } from '@bonsai/shared';

import type { NodeRow, Store } from '../db/store.js';
import { contextFileAt, readContextFile } from '../git/context.js';
import { parentSnapshot } from '../git/diff.js';
import { gitLine } from '../git/exec.js';
import {
  reviewFileContent,
  prepareReviewSource,
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
  const workspace = store.workspaces.get(row.project_id);
  if (workspace && (workspace.switch_json || workspace.active_node_id !== row.id)) {
    const project = store.getProject(row.project_id);
    return project ? { cwd: project.repo_path, committedOnly: true } : null;
  }
  if (row.worktree_allocated !== 0) return { cwd: row.worktree_path, committedOnly: false };
  if (store.workspaces.get(row.project_id)) {
    const project = store.getProject(row.project_id);
    return project ? { cwd: project.repo_path, committedOnly: true } : null;
  }
  if (row.archived_at === null) return null;
  const project = store.getProject(row.project_id);
  return project === undefined ? null : { cwd: project.repo_path, committedOnly: true };
}

/**
 * Where a scope's changes are read. The whole line is committed work, so an
 * experiment that has no folder yet -- created, never run -- still shows what
 * it inherited, read from the repository.
 */
function sourceFor(store: Store, row: NodeRow, scope: ChangeScope): ReviewSource | null {
  const source = reviewSource(store, row);
  if (source !== null || scope === 'own') return source;
  const project = store.getProject(row.project_id);
  return project === undefined ? null : { cwd: project.repo_path, committedOnly: true };
}

/**
 * Where an experiment's line left master: the last commit of master's that
 * its code contains. Everything after it, up to the experiment, is what the
 * line's experiments did.
 *
 * Asked of git rather than walked through the tree. Master of a project made
 * from a folder never moves, so this is the snapshot; master of a project
 * Bonsai created may have committed since, and merge-base finds the commit
 * the line actually branched from rather than master's latest. Null for
 * master itself, which has no line.
 */
export async function lineBase(store: Store, row: NodeRow): Promise<string | null> {
  if (row.parent_id === null) return null;
  let root = row;
  while (root.parent_id !== null) {
    const parent = store.getNode(root.parent_id);
    if (parent === undefined) return null;
    root = parent;
  }
  const tip = row.head_commit ?? row.base_commit;
  const project = store.getProject(row.project_id);
  if (tip === null || root.head_commit === null || project === undefined) return null;
  return gitLine(['merge-base', root.head_commit, tip], project.repo_path);
}

/**
 * An experiment's CONTEXT.md, and where its history can be read: the folder,
 * or -- once it is archived -- the repository at the experiment's last commit.
 */
export async function experimentNotes(
  store: Store,
  row: NodeRow,
): Promise<{ contextMd: string | null; cwd: string; head: string }> {
  return stableRead(store, row, (fresh) => experimentNotesAt(store, fresh));
}

async function experimentNotesAt(
  store: Store,
  row: NodeRow,
): Promise<{ contextMd: string | null; cwd: string; head: string }> {
  const source = reviewSource(store, row);
  const notesPath = store.getProject(row.project_id)?.notes_path ?? 'CONTEXT.md';
  const head = row.head_commit ?? row.base_commit;
  if (source?.committedOnly !== true || head === null)
    return {
      contextMd: await readContextFile(row.worktree_path, notesPath),
      cwd: row.worktree_path,
      head: 'HEAD',
    };
  return { contextMd: await contextFileAt(source.cwd, head, notesPath), cwd: source.cwd, head };
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
  scope: ChangeScope = 'own',
): Promise<{ base: string; head: string } | null> {
  if (scope === 'line') {
    const base = await lineBase(store, row);
    const tip = row.head_commit ?? row.base_commit;
    if (base !== null && tip !== null && base !== tip) return { base, head: tip };
  }
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

export function baseLabel(store: Store, row: NodeRow, scope: ChangeScope = 'own'): string {
  if (row.parent_id === null) return 'the code before this experiment’s first modifying run';
  if (scope === 'line')
    return `the code ${rootOf(store, row).display_name} had when this line began`;
  return `the inherited code snapshot from ${store.lineageOf(row).codeFrom?.displayName ?? 'its source experiment'}`;
}

function rootOf(store: Store, row: NodeRow): NodeRow {
  let root = row;
  while (root.parent_id !== null) {
    const parent = store.getNode(root.parent_id);
    if (parent === undefined) break;
    root = parent;
  }
  return root;
}

/** The files a scope covers, uncommitted work included where there is a folder. */
async function filesOf(store: Store, row: NodeRow, scope: ChangeScope) {
  const source = sourceFor(store, row, scope);
  return source === null ? [] : reviewFiles(source, await reviewRange(store, row, scope));
}

/**
 * Whether the two scopes can differ: only below master's direct children,
 * and only when something between them committed. Null when they are one.
 */
export async function scopesDiffer(store: Store, row: NodeRow): Promise<boolean> {
  if (row.parent_id === null) return false;
  const base = await lineBase(store, row);
  return base !== null && base !== row.base_commit;
}

export async function reviewOf(
  store: Store,
  row: NodeRow,
  scope: ChangeScope = 'own',
): Promise<ReviewView> {
  return stableRead(store, row, (fresh) => reviewAt(store, fresh, scope));
}

async function reviewAt(store: Store, row: NodeRow, scope: ChangeScope): Promise<ReviewView> {
  const files = await filesOf(store, row, scope);
  const differ = await scopesDiffer(store, row);
  const other = differ ? await filesOf(store, row, scope === 'own' ? 'line' : 'own') : files;
  return {
    nodeId: row.id,
    displayName: row.display_name,
    baseLabel: baseLabel(store, row, scope),
    scope,
    scopes: differ
      ? scope === 'own'
        ? { own: files.length, line: other.length }
        : { own: other.length, line: files.length }
      : null,
    line: differ ? lineNames(store, row) : null,
    totals: totalsOf(files),
    files,
  };
}

/** The experiments a line runs through, master first: what "whole line" means here. */
function lineNames(store: Store, row: NodeRow): string[] {
  const names: string[] = [];
  let node: NodeRow | undefined = row;
  while (node !== undefined) {
    names.unshift(node.display_name);
    node = node.parent_id === null ? undefined : store.getNode(node.parent_id);
  }
  return names;
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
  scope: ChangeScope = 'own',
): Promise<ReviewFilePatchView> {
  return stableRead(store, row, (fresh) => reviewPatchAt(store, fresh, path, fullFile, scope));
}

async function reviewPatchAt(
  store: Store,
  row: NodeRow,
  path: string,
  fullFile: boolean,
  scope: ChangeScope,
): Promise<ReviewFilePatchView> {
  const initialSource = sourceFor(store, row, scope);
  if (initialSource === null)
    throw new HttpError(404, 'This experiment has not created a checkout yet.');
  const range = await reviewRange(store, row, scope);
  const source = await prepareReviewSource(initialSource, range);
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

/** Discard live results if the checkout changed owners while Git/file reads were awaited. */
async function stableRead<T>(
  store: Store,
  row: NodeRow,
  read: (fresh: NodeRow) => Promise<T>,
): Promise<T> {
  const before = store.workspaces.get(row.project_id);
  let result: T | undefined;
  let failure: unknown;
  try {
    result = await read(row);
  } catch (error) {
    failure = error;
  }
  const after = store.workspaces.get(row.project_id);
  if (
    before &&
    after &&
    (before.generation !== after.generation || before.switch_json !== after.switch_json)
  ) {
    const fresh = store.getNode(row.id);
    if (!fresh) throw new HttpError(404, 'The experiment was deleted.');
    // A retry reads only its exact saved commit, even if it becomes active again.
    return read({
      ...fresh,
      worktree_allocated: 0,
      archived_at: fresh.archived_at ?? fresh.created_at,
    });
  }
  if (failure !== undefined)
    throw failure instanceof Error ? failure : new Error('Could not read this experiment.');
  return result!;
}
