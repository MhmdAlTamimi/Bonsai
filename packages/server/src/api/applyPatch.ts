import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplyPatchView } from '@bonsai/shared';

import type { NodeRow, Store } from '../db/store.js';
import { CONTEXT_FILE } from '../git/commit.js';
import { git, gitLine } from '../git/exec.js';
import { parseNumstat } from '../git/review.js';
import { HttpError } from './http.js';
import { reviewRange } from './review.js';

/**
 * Taking an experiment's changes to your own repository: a patch file and the
 * one command that applies it.
 *
 * Bonsai writes the file in its own data folder and never touches your
 * repository -- running the command, reviewing what it did and committing it
 * are yours. A file rather than `git diff | git apply` because Windows
 * PowerShell re-encodes text piped between commands and can corrupt a patch.
 *
 * The patch is the experiment's committed change, the same range review shows,
 * without Bonsai's CONTEXT.md notes. `--binary --full-index` so images apply
 * and `git apply --3way` can find the original files when your code has moved
 * on since the experiment started.
 */

/** Patches older than this are removed when a new one is written. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Everything except Bonsai's notes, wherever the experiment's working folder is. */
const WITHOUT_NOTES = `:(top,exclude)${CONTEXT_FILE}`;

export async function writeApplyPatch(
  store: Store,
  row: NodeRow,
  folder: string,
): Promise<ApplyPatchView> {
  const project = store.getProject(row.project_id);
  if (project === undefined) throw new HttpError(404, 'No such project.');
  const range = await reviewRange(store, row);
  if (range === null || range.base === range.head)
    throw new HttpError(409, 'This experiment has committed nothing to apply yet.');

  const numbers = parseNumstat(
    await git(
      ['diff', '--numstat', '-z', range.base, range.head, '--', WITHOUT_NOTES],
      project.repo_path,
    ),
  );
  if (numbers.size === 0)
    throw new HttpError(409, 'Only Bonsai’s notes changed, so there is nothing to apply.');

  await mkdir(folder, { recursive: true });
  await prune(folder);
  const path = join(folder, `${slug(row.display_name)}-${range.head.slice(0, 7)}.patch`);
  await git(
    [
      'diff',
      '--binary',
      '--full-index',
      `--output=${path}`,
      range.base,
      range.head,
      '--',
      WITHOUT_NOTES,
    ],
    project.repo_path,
  );

  const counts = [...numbers.values()];
  return {
    path,
    command: `git apply --3way "${path}"`,
    files: numbers.size,
    added: counts.reduce((n, c) => n + c.additions, 0),
    removed: counts.reduce((n, c) => n + c.deletions, 0),
    behind: await behindParent(store, row, project.repo_path),
  };
}

/**
 * How far the experiment's code source has moved on since it started: the
 * nearest ancestor that has committed, which is where its code came from.
 */
async function behindParent(
  store: Store,
  row: NodeRow,
  repoPath: string,
): Promise<ApplyPatchView['behind']> {
  if (row.base_commit === null) return null;
  let cursor = row.parent_id === null ? undefined : store.getNode(row.parent_id);
  while (cursor?.head_commit === null)
    cursor = cursor.parent_id === null ? undefined : store.getNode(cursor.parent_id);
  if (cursor?.head_commit == null || cursor.head_commit === row.base_commit) return null;
  const commits = Number(
    await gitLine(['rev-list', '--count', `${row.base_commit}..${cursor.head_commit}`], repoPath),
  );
  return commits > 0 ? { commits, parentName: cursor.display_name } : null;
}

/** A file name from a display name: plain letters, digits and dashes. */
function slug(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out === '' ? 'experiment' : out;
}

async function prune(folder: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(folder)) {
    if (!name.endsWith('.patch')) continue;
    const path = join(folder, name);
    try {
      if (now - (await stat(path)).mtimeMs > KEEP_MS) await rm(path, { force: true });
    } catch {
      // Gone already, or in use: neither matters.
    }
  }
}
