import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';

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
 *
 * D37: A FOLDER INSIDE A REPOSITORY IS A VALID CHOICE, and the model is the one
 * an editor uses when you open a folder:
 *
 *   the repository root is the project's IDENTITY -- its branches, its history,
 *   its commits, all of it, whole;
 *   the selected folder is the agent's WORKING SCOPE -- where it starts, what it
 *   sees first, where the setup command runs.
 *
 * So `mainproject/subproject1/prompts` is adoptable: the project is
 * `mainproject`, on the branch it is already on, and the agent works in
 * `subproject1/prompts`. Bonsai never creates a second repository inside the
 * folder you picked, and never invents a branch because you picked a nested
 * folder. This used to be refused outright with advice to pick the root
 * instead, which meant a monorepo could only be worked on as a whole.
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
  /**
   * The repository this folder belongs to -- the NEAREST enclosing one, which
   * is the same repository the user's own git commands would act on standing
   * here. Null when the folder is in no repository, in which case adopting it
   * makes one where it is.
   */
  repoRoot: string | null;
  /**
   * The selected folder relative to `repoRoot`, '/'-separated, '' for the root
   * itself. This is the agent's working directory inside every node.
   */
  workDir: string;
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
    repoRoot: null,
    workDir: '',
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
   * Looking for a `.git` entry answers "is this a repository ROOT", which is a
   * different question from the one that has to be answered: which repository
   * does this folder belong to? `--show-toplevel` walks up and stops at the
   * first one, which for nested repositories and submodules is the nearest --
   * the same repository the user's own git commands would act on standing here.
   */
  let repoRoot: string;
  try {
    repoRoot = resolve(await gitLine(['rev-parse', '--show-toplevel'], full));
  } catch {
    // Genuinely not in a repository. Adopting makes one here, in this folder,
    // and the working directory is that folder's root.
    return result;
  }

  /**
   * A linked worktree -- `git worktree add` -- reports itself as a toplevel,
   * so the check above lets it through. Adopting one would give Bonsai a
   * project whose refs live in a repository somewhere else entirely, including,
   * most likely, one of Bonsai's own node worktrees.
   */
  try {
    const gitDir = await gitLine(['rev-parse', '--absolute-git-dir'], repoRoot);
    const common = await gitLine(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      repoRoot,
    );
    if (resolve(gitDir) !== resolve(common)) {
      return {
        ...result,
        isGitRepo: true,
        repoRoot,
        workDir: relativeWorkDir(repoRoot, full),
        blockedReason:
          `This folder is a second checkout of a repository that lives at ${repoRootOf(common)}. ` +
          `Pick that repository's main folder instead.`,
      };
    }
  } catch {
    // An older git without --path-format: skip the check rather than block.
  }

  try {
    // Asked of the REPOSITORY, not of the selected folder: the branch, the head
    // and the uncommitted work all belong to the repository as a whole, and a
    // node branches from all of it however narrow its working directory is.
    const branch = await gitLine(['branch', '--show-current'], repoRoot);
    let head: string | null = null;
    try {
      head = await gitLine(['rev-parse', 'HEAD'], repoRoot);
    } catch {
      head = null; // a repository with no commits yet
    }
    return {
      ...result,
      isGitRepo: true,
      repoRoot,
      workDir: relativeWorkDir(repoRoot, full),
      branch: branch === '' ? null : branch,
      headCommit: head,
      dirtyFiles: (await status(repoRoot)).length,
    };
  } catch (err) {
    return {
      ...result,
      repoRoot,
      workDir: relativeWorkDir(repoRoot, full),
      blockedReason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The selected folder as the agent will see it: relative to the repository
 * root, '/'-separated so it means the same thing on every platform, and '' for
 * the root itself.
 */
export function relativeWorkDir(repoRoot: string, selected: string): string {
  const rel = relative(resolve(repoRoot), resolve(selected));
  if (rel === '' || rel === '.') return '';
  // A selection outside the root cannot happen -- the root came from walking up
  // from the selection -- but a '..' would silently escape, so it is refused.
  if (rel.startsWith('..')) return '';
  return rel.split(sep).join('/');
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
  /** The repository root: the project's identity. */
  repoPath: string;
  /**
   * The agent's working directory inside it, '/'-separated, '' for the root.
   * D37: the repository is what git sees; this is where the agent stands.
   */
  workDir: string;
  branch: string;
  headCommit: string;
  /** True when Bonsai had to create the repository or its first commit. */
  initialised: boolean;
}

/**
 * Makes a directory usable as a project, doing the least possible to it.
 *
 * A folder in no repository is turned into one, with a single commit, because
 * Bonsai needs a commit to branch from and there is no way around that.
 *
 * A folder INSIDE a repository is not initialised at all. The enclosing
 * repository is the project, exactly as it stands -- its branch, its history --
 * and the folder that was picked becomes the agent's working directory within
 * it (D37). Bonsai will not create a nested repository inside someone's
 * repository, and will not invent a branch because a subfolder was chosen.
 */
export async function adoptDirectory(path: string): Promise<AdoptedRepo> {
  const full = resolve(path);
  const inspection = await inspectDirectory(full);
  if (inspection.blockedReason !== null) throw new Error(inspection.blockedReason);
  if (!inspection.isDirectory) throw new Error('That folder cannot be used.');

  let initialised = false;
  let repoRoot = inspection.repoRoot;

  if (repoRoot === null) {
    await git(['init', '--initial-branch=main', '.'], full);
    repoRoot = full;
    initialised = true;
  }

  const workDir = relativeWorkDir(repoRoot, full);

  let branch = await gitLine(['branch', '--show-current'], repoRoot);
  if (branch === '') {
    // Detached HEAD: put the user back on a named branch, because every node
    // Bonsai creates needs a branch to exist alongside.
    branch = 'main';
    await git(['checkout', '-B', branch], repoRoot);
  }

  let head: string;
  try {
    head = await gitLine(['rev-parse', 'HEAD'], repoRoot);
  } catch {
    // A repository with no commits at all cannot be branched from, so make the
    // one commit that unblocks everything -- and only in that case.
    await git(['add', '-A'], repoRoot);
    await git(['commit', '-m', 'Initial commit (created by Bonsai)'], repoRoot);
    head = await gitLine(['rev-parse', 'HEAD'], repoRoot);
    initialised = true;
  }

  return { repoPath: repoRoot, workDir, branch, headCommit: head, initialised };
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
