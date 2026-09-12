import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { git, gitLine, status } from './exec.js';

/**
 * Adopting a directory the user already has.
 *
 * "Import" here does not mean copying anything anywhere: Bonsai uses the
 * directory in place. The folder becomes the project's repository, master is
 * that directory on whatever branch it is already on, and child nodes are
 * worktrees elsewhere on `node/<uuid>` branches INSIDE the user's repository.
 *
 * That has a consequence worth being deliberate about: work done in a node
 * lands on a real branch in the user's own repo, reachable with their normal
 * tools. It also means Bonsai writes refs into a repository it did not create,
 * which is why deletion is so carefully constrained (see projects.ts).
 *
 * Existing branches are NOT turned into nodes. Git branches form a DAG rather
 * than a tree, git does not record which branch was forked from which, and --
 * decisively -- an imported branch has no conversation, and a node without one
 * is an empty shell that gives its children nothing.
 */

export interface DirectoryInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  /** Already a git repository. */
  isGitRepo: boolean;
  /** The checked-out branch, when there is one. */
  branch: string | null;
  /** Null for a repo with no commits yet. */
  headCommit: string | null;
  /** Uncommitted changes; nodes branch from the last commit unless snapshotted. */
  dirtyFiles: number;
  /** Rough count of entries, to warn before committing something enormous. */
  entryCount: number;
  /** Reason this directory cannot be adopted, if any. */
  blockedReason: string | null;
}

/**
 * Note what is NOT in the interface above: anything Bonsai knows about its own
 * projects. This module shells out to git and must not gain a database
 * dependency, so recognising a folder as one of Bonsai's own is the route's
 * job -- see api/router.ts, which does that lookup before calling in here.
 */

/** Looks at a directory without changing anything. */
export async function inspectDirectory(path: string): Promise<DirectoryInspection> {
  const full = resolve(path);
  const base: DirectoryInspection = {
    path: full,
    exists: false,
    isDirectory: false,
    isGitRepo: false,
    branch: null,
    headCommit: null,
    dirtyFiles: 0,
    entryCount: 0,
    blockedReason: null,
  };

  if (!existsSync(full)) return { ...base, blockedReason: 'That folder does not exist.' };
  const info = await stat(full);
  if (!info.isDirectory())
    return { ...base, exists: true, blockedReason: 'That is a file, not a folder.' };

  const entries = await readdir(full);
  const result: DirectoryInspection = {
    ...base,
    exists: true,
    isDirectory: true,
    entryCount: entries.length,
  };

  /**
   * Asked of git rather than of the filesystem, and that distinction matters.
   *
   * Looking for a `.git` entry answers "is this a repository root", but the
   * case that has to be caught is a folder INSIDE someone's repository -- which
   * has no `.git` of its own and would otherwise look like a plain folder.
   * Adopting it would then `git init` a nested repository inside theirs, which
   * is a mess to unpick and confusing long before anyone notices.
   */
  let top: string;
  try {
    top = await gitLine(['rev-parse', '--show-toplevel'], full);
  } catch {
    return result; // genuinely not in a repository: a plain folder, adoptable
  }

  if (resolve(top) !== full) {
    return {
      ...result,
      isGitRepo: true,
      blockedReason: `That folder is inside a git repository rooted at ${top}. Choose that folder instead.`,
    };
  }

  /**
   * A linked worktree -- `git worktree add` -- reports itself as a toplevel,
   * so the check above lets it through. Adopting one would give Bonsai a
   * project whose refs live in a repository somewhere else entirely, including,
   * most likely, one of Bonsai's own node worktrees.
   */
  try {
    const gitDir = await gitLine(['rev-parse', '--absolute-git-dir'], full);
    const common = await gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], full);
    if (resolve(gitDir) !== resolve(common)) {
      return {
        ...result,
        isGitRepo: true,
        blockedReason:
          `This folder is a second checkout of a repository that lives at ${repoRootOf(common)}. ` +
          `Pick that repository's main folder instead.`,
      };
    }
  } catch {
    // An older git without --path-format: skip the check rather than block.
  }

  try {
    const branch = await gitLine(['branch', '--show-current'], full);
    let head: string | null = null;
    try {
      head = await gitLine(['rev-parse', 'HEAD'], full);
    } catch {
      head = null; // a repository with no commits yet
    }
    return {
      ...result,
      isGitRepo: true,
      branch: branch === '' ? null : branch,
      headCommit: head,
      dirtyFiles: (await status(full)).length,
    };
  } catch (err) {
    return { ...result, blockedReason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The working folder a `.git` directory belongs to.
 *
 * `--git-common-dir` answers with the `.git` directory itself, and the string
 * that used to strip it was written with a forward slash -- so on Windows the
 * user was shown `C:\\work\\repo\\.git` and told to pick it, which is not a
 * folder they can pick. The path module knows which separator it is on.
 */
function repoRootOf(gitDir: string): string {
  const full = resolve(gitDir);
  return basename(full) === '.git' ? dirname(full) : full;
}

export interface AdoptedRepo {
  repoPath: string;
  branch: string;
  headCommit: string;
  /** True when Bonsai had to create the repository or its first commit. */
  initialised: boolean;
}

/**
 * Makes a directory usable as a project, doing the least possible to it.
 *
 * A plain folder is turned into a git repository with one commit, because
 * Bonsai needs a commit to branch from and there is no way around that. A
 * folder that is already a repository is left completely alone -- no commits,
 * no branches, no config -- beyond reading where its HEAD is.
 */
export async function adoptDirectory(path: string): Promise<AdoptedRepo> {
  const full = resolve(path);
  const inspection = await inspectDirectory(full);
  if (inspection.blockedReason !== null) throw new Error(inspection.blockedReason);
  if (!inspection.isDirectory) throw new Error('That folder cannot be used.');

  let initialised = false;

  if (!inspection.isGitRepo) {
    await git(['init', '--initial-branch=main', '.'], full);
    initialised = true;
  }

  let branch = await gitLine(['branch', '--show-current'], full);
  if (branch === '') {
    // Detached HEAD: put the user back on a named branch, because every node
    // Bonsai creates needs a branch to exist alongside.
    branch = 'main';
    await git(['checkout', '-B', branch], full);
  }

  let head: string;
  try {
    head = await gitLine(['rev-parse', 'HEAD'], full);
  } catch {
    // A repository with no commits at all cannot be branched from, so make the
    // one commit that unblocks everything -- and only in that case.
    await git(['add', '-A'], full);
    await git(['commit', '-m', 'Initial commit (created by Bonsai)'], full);
    head = await gitLine(['rev-parse', 'HEAD'], full);
    initialised = true;
  }

  return { repoPath: full, branch, headCommit: head, initialised };
}

/**
 * A commit object for the current uncommitted state, belonging to no branch.
 *
 * Lets nodes branch from work in progress without Bonsai committing anything to
 * the user's branch. `git stash create` builds the commit and leaves the
 * working tree exactly as it was.
 */
export async function snapshotUncommitted(repoPath: string): Promise<string | null> {
  const dirty = await status(repoPath);
  if (dirty.length === 0) return null;
  const sha = await gitLine(['stash', 'create', 'Bonsai: uncommitted work at import'], repoPath);
  return sha === '' ? null : sha;
}

export function suggestProjectName(path: string): string {
  return basename(resolve(path)) || 'project';
}
