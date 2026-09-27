import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplyPatchView, ChangeScope } from '@bonsai/shared';

import type { NodeRow, Store } from '../db/store.js';
import { CONTEXT_FILE } from '../git/commit.js';
import { git } from '../git/exec.js';
import { parseNumstat } from '../git/review.js';
import { behindBy } from './behind.js';
import { HttpError } from './http.js';
import { reviewRange, scopesDiffer } from './review.js';

/**
 * Taking an experiment's changes to your own repository: a patch file and the
 * one command that applies it.
 *
 * Bonsai writes the file in its own data folder and never touches your
 * repository -- running the command, reviewing what it did and committing it
 * are yours. A file rather than `git diff | git apply` because Windows
 * PowerShell re-encodes text piped between commands and can corrupt a patch.
 *
 * The patch is the experiment's committed change, the same range review shows
 * for the same scope, without Bonsai's CONTEXT.md notes. `--binary
 * --full-index` so images apply and `git apply --3way` can find the original
 * files when your code has moved on since the experiment started.
 *
 * THE WHOLE LINE BY DEFAULT. Your folder is at master's code, and an
 * experiment's own step is only its change on top of its parents': a patch
 * of that alone fails on a file a parent added, or quietly applies half a
 * feature. `own` is for when the parents' work is already in your folder.
 *
 * For a project made from a folder the command names that folder (`git -C`),
 * so it works from any terminal: `git apply` run in a subfolder silently
 * skips every file outside it.
 */

/** Patches older than this are removed when a new one is written. */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Everything except Bonsai's notes, wherever the experiment's working folder is. */
const WITHOUT_NOTES = `:(top,exclude)${CONTEXT_FILE}`;

export async function writeApplyPatch(
  store: Store,
  row: NodeRow,
  folder: string,
  scope: ChangeScope = 'line',
): Promise<ApplyPatchView> {
  const project = store.getProject(row.project_id);
  if (project === undefined) throw new HttpError(404, 'No such project.');
  const differ = await scopesDiffer(store, row);
  const range = await reviewRange(store, row, scope);
  if (range === null || range.base === range.head)
    throw new HttpError(
      409,
      scope === 'own' && differ
        ? 'This experiment has committed nothing of its own yet; its whole line has changes to apply.'
        : 'This experiment has committed nothing to apply yet.',
    );

  const numbers = await changedFiles(project.repo_path, range);
  if (numbers.size === 0)
    throw new HttpError(409, 'Only Bonsai’s notes changed, so there is nothing to apply.');
  const other = differ
    ? await reviewRange(store, row, scope === 'own' ? 'line' : 'own').then((r) =>
        r === null ? 0 : changedFiles(project.repo_path, r).then((n) => n.size),
      )
    : numbers.size;

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
  const yours = project.source_kind === 'adopted' ? project.repo_path : null;
  return {
    path,
    command:
      yours === null ? `git apply --3way "${path}"` : `git -C "${yours}" apply --3way "${path}"`,
    folder: yours,
    scope,
    scopes: differ
      ? scope === 'own'
        ? { own: numbers.size, line: other }
        : { own: other, line: numbers.size }
      : null,
    branchMismatch: yours === null ? null : await mismatch(yours, project.protected_branch),
    files: numbers.size,
    added: counts.reduce((n, c) => n + c.additions, 0),
    removed: counts.reduce((n, c) => n + c.deletions, 0),
    behind: await behindBy(store, row, project.repo_path),
  };
}

/** The files a range changes, and by how much, without Bonsai's notes. */
async function changedFiles(
  repoPath: string,
  range: { base: string; head: string },
): Promise<ReturnType<typeof parseNumstat>> {
  return parseNumstat(
    await git(['diff', '--numstat', '-z', range.base, range.head, '--', WITHOUT_NOTES], repoPath),
  );
}

/**
 * Said before you apply: the project started from one branch and your folder
 * is on another, so the change would land there. Read-only, and quiet when
 * git cannot say (a detached checkout, a folder that moved).
 */
async function mismatch(
  folder: string,
  startedFrom: string | null,
): Promise<{ startedFrom: string; folderOn: string } | null> {
  if (startedFrom === null) return null;
  let folderOn: string;
  try {
    folderOn = (await git(['branch', '--show-current'], folder)).trim();
  } catch {
    return null;
  }
  return folderOn === '' || folderOn === startedFrom ? null : { startedFrom, folderOn };
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
