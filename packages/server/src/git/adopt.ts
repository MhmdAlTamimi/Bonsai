import { workingTreeSnapshot } from './snapshot.js';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';

import { git, gitLine, status } from './exec.js';
import { canonicalPath, samePath } from '../paths.js';

/**
 * Adopting a directory the user already has.
 *
 * "Import" here does not mean copying anything anywhere: Bonsai uses the
 * directory's repository in place. Master is a checkout of one version of it
 * -- the branch the folder is on, or any other branch, remote branch or tag the
 * user picks -- and every node is a worktree elsewhere, its commits kept by
 * hidden refs INSIDE the user's repository (git/refs.ts). The folder itself is
 * only read, so picking a branch never switches the folder to it.
 *
 * Bonsai still writes into a repository it did not create -- objects, refs,
 * worktree records -- which is why deletion is so carefully constrained (see
 * projects.ts).
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
  /**
   * The versions a project can start from, newest first: local branches,
   * remote branches and tags, plus the checked-out commit when the folder is
   * on none of them. Empty outside a repository or before its first commit.
   */
  startPoints: StartPoint[];
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

export interface StartPoint {
  /** The full ref (`refs/heads/feature-x`), or `HEAD` for a detached checkout. Sent back to start from it. */
  ref: string;
  /** What people call it: `feature-x`, `origin/fix`, `v2.1`, or a short commit. */
  name: string;
  kind: 'branch' | 'remote' | 'tag' | 'commit';
  commit: string;
  /** When its latest commit was made (a tag's: when it was tagged). */
  date: string;
  /** What the folder has checked out: the one version its unsaved changes belong to. */
  current: boolean;
}

/**
 * Note what is NOT in the interface above: anything Bonsai knows about its own
 * projects. This module shells out to git and must not gain a database
 * dependency, so recognising a folder as one of Bonsai's own is the route's
 * job -- see api/router.ts, which does that lookup before calling in here.
 */

/** Looks at a directory without changing anything. */
export async function inspectDirectory(path: string): Promise<DirectoryInspection> {
  const full = await canonicalPath(path);
  const base: DirectoryInspection = {
    path: full,
    exists: false,
    isDirectory: false,
    isGitRepo: false,
    branch: null,
    startPoints: [],
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

  if (samePath(full, parse(full).root) || samePath(full, await canonicalPath(homedir())))
    return {
      ...result,
      blockedReason: 'Choose a project folder, rather than your home folder or the whole disk.',
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
    repoRoot = await canonicalPath(await gitLine(['rev-parse', '--show-toplevel'], full));
  } catch {
    // Genuinely not in a repository. Adopting makes one here, in this folder,
    // and the working directory is that folder's root.
    return result;
  }

  if (
    samePath(repoRoot, parse(repoRoot).root) ||
    samePath(repoRoot, await canonicalPath(homedir()))
  )
    return {
      ...result,
      repoRoot,
      blockedReason:
        'This repository contains your home folder or the whole disk. Choose a separate project repository.',
    };

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
    if (!samePath(gitDir, common)) {
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
      // A detached checkout is no longer refused: master is a checkout of its
      // own, so any version can be where a project starts.
      blockedReason: null,
      startPoints: head === null ? [] : await listStartPoints(repoRoot),
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
  /** The user's original folder, also when its snapshot repository is managed by Bonsai. */
  sourcePath: string;
  /**
   * The agent's working directory inside it, '/'-separated, '' for the root.
   * D37: the repository is what git sees; this is where the agent stands.
   */
  workDir: string;
  /** What the project starts from, as people call it: `main`, `origin/fix`, `v2.1`. */
  label: string;
  /** The commit it starts from. */
  headCommit: string;
  /** Whether that is what the folder has checked out, which its unsaved changes sit on. */
  current: boolean;
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
export async function adoptDirectory(
  path: string,
  startFrom?: string,
  managedRepoPath?: string,
): Promise<AdoptedRepo> {
  const full = await canonicalPath(path);
  const inspection = await inspectDirectory(full);
  if (inspection.blockedReason !== null) throw new Error(inspection.blockedReason);
  if (!inspection.isDirectory) throw new Error('That folder cannot be used.');

  const sourcePath = inspection.repoRoot ?? full;
  const workDir = relativeWorkDir(sourcePath, full);
  if (inspection.headCommit === null) {
    if (startFrom !== undefined && startFrom !== 'HEAD')
      throw new Error('This folder has no saved versions to select.');
    if (managedRepoPath === undefined)
      throw new Error('This folder needs an initial snapshot in Bonsai’s managed storage.');
    const headCommit = await importFolder(sourcePath, managedRepoPath);
    return {
      repoPath: managedRepoPath,
      sourcePath,
      workDir,
      label: 'main',
      headCommit,
      current: true,
      initialised: true,
    };
  }

  const repoRoot = inspection.repoRoot!;
  const branch = await gitLine(['branch', '--show-current'], repoRoot);
  const head = inspection.headCommit;

  const checkedOut = { label: branch === '' ? head.slice(0, 7) : branch, commit: head };
  if (startFrom === undefined || startFrom === 'HEAD' || startFrom === `refs/heads/${branch}`) {
    return {
      repoPath: repoRoot,
      sourcePath,
      workDir,
      label: checkedOut.label,
      headCommit: checkedOut.commit,
      current: true,
      initialised: false,
    };
  }
  // Only what the page offered: a branch, a remote branch or a tag. Read, never
  // checked out -- the folder stays on whatever it is on.
  const kind = START_POINT_KINDS.find(([prefix]) => startFrom.startsWith(prefix));
  if (kind === undefined)
    throw new Error('Choose a branch, a remote branch or a tag to start from.');
  let commit: string;
  try {
    commit = await gitLine(['rev-parse', '--verify', '--quiet', `${startFrom}^{commit}`], repoRoot);
  } catch {
    throw new Error(`${startFrom.slice(kind[0].length)} is no longer in this repository.`);
  }
  return {
    repoPath: repoRoot,
    sourcePath,
    workDir,
    label: startFrom.slice(kind[0].length),
    headCommit: commit,
    current: false,
    initialised: false,
  };
}

/** Read files through an isolated index; never initialise or stage in the source folder. */
async function importFolder(source: string, repo: string): Promise<string> {
  await mkdir(repo, { recursive: true });
  try {
    await git(['init', '--bare', '--initial-branch=main', '.'], repo);
    await writeFile(join(repo, 'info', 'exclude'), IMPORT_EXCLUDES);
    const env = {
      GIT_DIR: repo,
      GIT_WORK_TREE: source,
      GIT_INDEX_FILE: join(repo, 'import.index'),
    };
    await git(['read-tree', '--empty'], source, env);
    await git(['add', '-A', '--', '.'], source, env);
    const tree = (await git(['write-tree'], source, env)).trim();
    const commit = await gitLine(
      ['commit-tree', tree, '-m', 'Initial folder snapshot (Bonsai)'],
      repo,
    );
    await git(['update-ref', 'refs/heads/main', commit], repo);
    await rm(env.GIT_INDEX_FILE, { force: true });
    return commit;
  } catch (error) {
    await rm(repo, { recursive: true, force: true });
    throw error;
  }
}

// Source .gitignore still applies. These additional rules prevent common local
// credentials and generated dependencies from entering a brand-new history.
const IMPORT_EXCLUDES =
  [
    'node_modules/',
    '.venv/',
    'venv/',
    '.tox/',
    'vendor/',
    'target/',
    'dist/',
    'build/',
    '.next/',
    '.cache/',
    '.DS_Store',
    '.env',
    '.env.*',
    '!.env.example',
    '!.env.sample',
    '!.env.template',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '.aws/',
    '.ssh/',
  ].join('\n') + '\n';

const START_POINT_KINDS = [
  ['refs/heads/', 'branch'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag'],
] as const;

/** How many of each kind are offered at most: a repository can have thousands of tags. */
const START_POINT_LIMIT = { branch: 200, remote: 100, tag: 30 } as const;

/**
 * Every version a project can start from, newest first.
 *
 * One `for-each-ref` for all of them. A tag can point at a tag object rather
 * than a commit, so the peeled fields (`*`) are read as well; a tag of
 * something that is not a commit is left out, and so is `origin/HEAD`, which
 * only names another remote branch.
 */
export async function listStartPoints(repoRoot: string): Promise<StartPoint[]> {
  const format = [
    '%(refname)',
    '%(objecttype)',
    '%(objectname)',
    '%(*objecttype)',
    '%(*objectname)',
    '%(creatordate:iso-strict)',
  ].join('%09');
  const [out, checkedOut, head] = await Promise.all([
    git(
      [
        'for-each-ref',
        '--sort=-creatordate',
        `--format=${format}`,
        'refs/heads',
        'refs/remotes',
        'refs/tags',
      ],
      repoRoot,
    ),
    git(['symbolic-ref', '-q', 'HEAD'], repoRoot).then(
      (ref) => ref.trim(),
      () => null,
    ),
    gitLine(['rev-parse', 'HEAD'], repoRoot),
  ]);

  const points: StartPoint[] = [];
  const counts = { branch: 0, remote: 0, tag: 0 };
  for (const line of out.split('\n')) {
    const [ref, type, object, peeledType, peeled, date] = line.split('\t');
    if (ref === undefined || ref === '' || ref.endsWith('/HEAD')) continue;
    const commit = type === 'commit' ? object : peeledType === 'commit' ? peeled : undefined;
    const match = START_POINT_KINDS.find(([prefix]) => ref.startsWith(prefix));
    if (commit === undefined || match === undefined) continue;
    const [prefix, kind] = match;
    const current = ref === checkedOut;
    if (!current && counts[kind] >= START_POINT_LIMIT[kind]) continue;
    counts[kind] += 1;
    points.push({ ref, name: ref.slice(prefix.length), kind, commit, date: date ?? '', current });
  }
  // A detached checkout is on no branch, and is still a version to start from.
  if (checkedOut === null) {
    const date = await gitLine(['show', '-s', '--format=%cI', head], repoRoot);
    points.unshift({
      ref: 'HEAD',
      name: head.slice(0, 7),
      kind: 'commit',
      commit: head,
      date,
      current: true,
    });
  }
  return points;
}

/** Snapshot tracked and untracked, nonignored files without touching the user's index or refs. */
export async function snapshotUncommitted(repoPath: string): Promise<string | null> {
  if ((await status(repoPath)).length === 0) return null;
  const head = await gitLine(['rev-parse', 'HEAD'], repoPath);
  const tree = await workingTreeSnapshot(repoPath);
  return (
    await git(['commit-tree', tree, '-p', head, '-m', 'Bonsai: working snapshot'], repoPath)
  ).trim();
}

export function suggestProjectName(path: string): string {
  return basename(resolve(path)) || 'project';
}
