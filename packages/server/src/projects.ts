import { mkdir, lstat, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { PermissionMode } from '@bonsai/shared';

import type { NodeRow, ProjectRow, Store } from './db/store.js';
import { workDirIn } from './db/rows.js';
import {
  DEFAULT_BRANCH,
  branchExists,
  branchNameFor,
  commitExists,
  createRepo,
} from './git/repo.js';
import {
  addBranchWorktree,
  addDetachedWorktree,
  deleteBranch,
  removeWorktree,
} from './git/worktree.js';
import { resolveBaseCommit } from './domain/lineage.js';
import { toLineage } from './db/store.js';
import { adoptDirectory, snapshotUncommitted, suggestProjectName } from './git/adopt.js';
import { assertGitState, expectedGitState } from './git/ownership.js';
import { gitLine } from './git/exec.js';
import {
  branchOf,
  deleteProjectRefs,
  deleteRef,
  nodeRef,
  pinNode,
  projectRefs,
  readRef,
  tipOf,
} from './git/refs.js';
import type { Logger } from './log.js';
import { OperationConflict } from './domain/errors.js';
import { seedFiles, type SeedFileOutcome } from './git/seedWorktree.js';

/**
 * The flows that need git and the database to agree. Kept out of the router so
 * the HTTP layer stays a thin translation of the contract.
 *
 * A project comes into being one of two ways, and the difference runs through
 * everything below:
 *
 *   CREATED - Bonsai makes a bare repository it owns outright, inside its own
 *   folder. It may delete all of it.
 *
 *   ADOPTED - the user points Bonsai at a directory they already have. Bonsai
 *   uses it in place: that folder IS the repository, master is that folder on
 *   its existing branch, and nodes are commits inside THEIR repository. Bonsai
 *   may delete only what it created.
 *
 * Either way every node has a hidden ref, `refs/bonsai/<project>/<node>`, at
 * its latest commit, which is what keeps its code in git (see git/refs.ts).
 * Experiments get no branches; older ones may still have a `node/<uuid>`.
 */

export async function createProject(
  store: Store,
  input: {
    name: string;
    description: string;
    model: string | null;
    permissionMode: PermissionMode;
    effort?: string | null;
    /**
     * Where master's checkout should live. Bonsai makes a new folder named
     * after the project inside it. Omitted keeps it in Bonsai's data directory,
     * which works but leaves the code at a path nobody would find by hand.
     */
    location?: string | null;
    expectedPath?: string;
  },
): Promise<{ projectId: string; masterNodeId: string; path: string }> {
  // Resolved before anything is created so a bad location fails cleanly, with
  // no repository left behind. The bare repo always stays in Bonsai's own
  // directory; only the checkout is placed where the user asked.
  const chosen =
    input.location === undefined || input.location === null || input.location.trim() === ''
      ? null
      : await prepareNewDirectory(input.location, input.name, input.expectedPath);

  let project: ProjectRow;
  try {
    project = store.createProject(input);
  } catch (error) {
    if (chosen !== null) await rmdir(chosen);
    throw error;
  }
  let checkout: string | null = null;
  try {
    const { rootCommit } = await createRepo(project.repo_path);

    // D24: master is a real branch and the only node that starts attached to one.
    // Its head commit exists before its worktree does -- that ordering is forced
    // by git and is what makes the lineage walk total (see lineage.ts).
    const master = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: DEFAULT_BRANCH,
      description: input.description,
      rootCommit,
      rootBranchName: DEFAULT_BRANCH,
      ...(chosen === null ? {} : { worktreePath: chosen }),
    });
    await pinNode(project.repo_path, master);

    await addBranchWorktree(project.repo_path, master.worktree_path, DEFAULT_BRANCH);
    checkout = master.worktree_path;
    // Recorded now rather than at insert because the default path contains the
    // node's own id. This is the path "reveal in file manager" opens, for created
    // and adopted projects alike.
    store.setProjectSourcePath(project.id, master.worktree_path);
    return { projectId: project.id, masterNodeId: master.id, path: master.worktree_path };
  } catch (error) {
    try {
      if (checkout !== null) await removeWorktree(project.repo_path, checkout);
      if (chosen !== null && (await pathExists(chosen))) await rmdir(chosen);
      await rm(dirname(project.repo_path), { recursive: true, force: true });
      store.deleteProject(project.id);
    } catch (cleanup) {
      throw new Error(
        `Project creation failed; retained project ${project.id} for recovery: ${String(error)}. Cleanup: ${String(cleanup)}`,
      );
    }
    throw error;
  }
}

/**
 * Picks the folder a new project's checkout goes in, and refuses to reuse one.
 *
 * Deleting a created project deletes this directory, so it must be one Bonsai
 * made. An existing folder with anything in it is rejected rather than merged
 * into: the alternative is a delete that takes the user's unrelated files with
 * it, and no amount of confirmation text makes that acceptable.
 */
export async function previewNewDirectory(location: string, name: string): Promise<string> {
  const parent = resolve(location);
  if (!(await stat(parent)).isDirectory()) throw new Error(`Not a folder: ${parent}`);

  const base = slugify(name);
  let target = join(parent, base);
  for (let n = 2; await pathExists(target); n += 1) {
    if (n > 99) throw new Error(`Could not find a free folder name in ${parent}`);
    target = join(parent, `${base}-${n}`);
  }

  return target;
}

async function prepareNewDirectory(
  location: string,
  name: string,
  expectedPath?: string,
): Promise<string> {
  const target = await previewNewDirectory(location, name);
  if (expectedPath !== undefined && target !== expectedPath)
    throw new Error(
      'The destination changed. Review the folder again before creating the project.',
    );
  await mkdir(target);
  return target;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s === '' ? 'project' : s;
}

/**
 * Adopts a directory the user already has.
 *
 * Nothing is copied and nothing is moved. Master's worktree IS the user's
 * folder; child nodes get detached worktrees under Bonsai's own directory,
 * their commits kept by hidden refs inside the user's repository -- never
 * branches, which would crowd their `git branch` and go out with a
 * `push --all`. Work goes back to them as a patch (Apply, api/applyPatch.ts).
 *
 * MASTER ENDS UP FROZEN, on purpose. Its worktree is the user's working
 * directory, so a run there would have Bonsai committing onto the branch they
 * are actually working on. Requiring a child before anything can change is D5
 * anyway; here it also guarantees Bonsai never writes to their checkout.
 *
 * Existing branches are deliberately not turned into nodes -- see git/adopt.ts
 * for why that is a dead end rather than a shortcut not taken.
 */
export async function adoptProject(
  store: Store,
  input: {
    path: string;
    name?: string;
    description: string;
    model: string | null;
    permissionMode: PermissionMode;
    effort?: string | null;
    /** Let nodes branch from uncommitted work, without committing it anywhere. */
    includeUncommitted?: boolean;
  },
): Promise<{
  projectId: string;
  masterNodeId: string;
  initialised: boolean;
  snapshot: boolean;
  /** The repository that became the project, which may enclose the chosen folder. */
  repoPath: string;
  /** The chosen folder relative to it. '' when the repository root was chosen. */
  workDir: string;
}> {
  const adopted = await adoptDirectory(input.path);

  let base = adopted.headCommit;
  let snapshot = false;
  if (input.includeUncommitted === true) {
    const sha = await snapshotUncommitted(adopted.repoPath);
    if (sha !== null) {
      base = sha;
      snapshot = true;
    }
  }

  const project = store.createProject({
    name:
      input.name === undefined || input.name.trim() === ''
        ? // The folder they PICKED, which is what an editor would put in its
          // title bar. The repository may be an ancestor of it, and naming the
          // project after the ancestor would not be recognisable as the thing
          // they chose. Display names are metadata and rename freely (D33).
          suggestProjectName(input.path)
        : input.name,
    description: input.description,
    model: input.model,
    permissionMode: input.permissionMode,
    effort: input.effort ?? null,
    adopt: {
      repoPath: adopted.repoPath,
      // The project's folder is the REPOSITORY, whichever folder was picked --
      // that is what git owns and what deletion must leave alone. Where the
      // agent stands inside it is `workDir` (D37).
      sourcePath: adopted.repoPath,
      protectedBranch: adopted.branch,
      workDir: adopted.workDir,
    },
  });

  let master: NodeRow;
  try {
    master = store.createNode({
      projectId: project.id,
      parentId: null,
      displayName: adopted.branch,
      description: input.description,
      rootCommit: base,
      rootBranchName: adopted.branch,
      // The user's own directory, not a worktree Bonsai created.
      worktreePath: adopted.repoPath,
    });
    // The commit every experiment here starts from. Their branch may move on,
    // and a snapshot of uncommitted work was never on it: no folder is ever
    // checked out at it either, so this ref is all that keeps it.
    await pinNode(adopted.repoPath, master);
  } catch (error) {
    store.deleteProject(project.id);
    throw error;
  }

  return {
    projectId: project.id,
    masterNodeId: master.id,
    initialised: adopted.initialised,
    snapshot,
    repoPath: adopted.repoPath,
    workDir: adopted.workDir,
  };
}

/**
 * Creates metadata and pins its base; checkout allocation waits for the first run.
 *
 * The worktree is DETACHED at the pinned base commit. No branch is created here
 * and none is named in git until the node's first commit, which is what makes
 * `creates_branch` an outcome rather than a creation-time choice.
 */
export async function createChildNode(
  store: Store,
  input: {
    projectId: string;
    parentId: string;
    displayName: string;
    description: string;
    model?: string | null;
    permissionMode?: PermissionMode | null;
    successCriteria?: string | null;
    verificationHint?: string | null;
  },
): Promise<{ nodeId: string; baseCommit: string; seeded: SeedFileOutcome[] }> {
  const project = store.getProject(input.projectId);
  if (project === undefined) throw new Error('no such project');
  const parent = store.getNode(input.parentId);
  if (parent === undefined) throw new Error('no such parent node');

  // Computed here as well as inside createNode so the value that reaches git is
  // provably the same one that reaches the database.
  const baseCommit = resolveBaseCommit(toLineage(parent));
  // Refused before anything is made: nothing can start from code git has lost.
  if (!(await commitExists(project.repo_path, baseCommit)))
    throw new OperationConflict(
      `The code this experiment would start from (commit ${baseCommit.slice(0, 7)}) is no longer in the repository.`,
    );

  const node = store.createNode(input);
  store.markAllocated(node.id, false);
  // From now on its code is kept whether or not it ever gets a folder.
  try {
    await pinNode(project.repo_path, node);
  } catch (error) {
    store.deleteNode(node.id);
    throw error;
  }
  return { nodeId: node.id, baseCommit, seeded: [] };
}

/** Folders being created right now, so a run and Open folder asking at once share one checkout. */
const allocating = new Map<string, Promise<SeedFileOutcome[]>>();

/**
 * Creates an experiment's folder when it has none: the first time it runs, or
 * again after it was archived. Missing established work is never recreated --
 * a folder that should be there and is not is an error, not a reason to make
 * a new one.
 */
export async function allocateNodeWorktree(
  store: Store,
  node: NodeRow,
): Promise<SeedFileOutcome[]> {
  if (node.worktree_allocated !== 0) return [];
  const pending = allocating.get(node.id);
  if (pending !== undefined) return pending;
  const work = createFolder(store, node).finally(() => allocating.delete(node.id));
  allocating.set(node.id, work);
  return work;
}

async function createFolder(store: Store, stale: NodeRow): Promise<SeedFileOutcome[]> {
  // Read again: whoever created it a moment ago has already recorded it.
  const node = store.getNode(stale.id) ?? stale;
  if (node.worktree_allocated !== 0) return [];
  const project = store.getProject(node.project_id);
  if (!project) throw new Error('No such project.');
  if (await pathExists(node.worktree_path))
    throw new Error(
      'An unexpected folder occupies this experiment location. Work preserved; inspect it before retrying.',
    );
  // Also where a node from before refs existed gets one, and where code git
  // no longer has is reported as that rather than as git's own error.
  await pinNode(project.repo_path, node);
  if (node.archived_at !== null) {
    // Back on its own branch when it has one, at the same path: the agent's
    // session is keyed by that path, so anywhere else would start it afresh.
    // Detached at its tip otherwise, which its ref keeps.
    const branch = branchOf(node);
    if (branch !== null && (await branchExists(project.repo_path, branch)))
      await addBranchWorktree(project.repo_path, node.worktree_path, branch);
    else {
      const commit = node.head_commit ?? node.base_commit;
      if (commit === null) throw new Error('This experiment has no recorded code snapshot.');
      await addDetachedWorktree(project.repo_path, node.worktree_path, commit);
    }
    store.markRestored(node.id);
  } else {
    if (!node.base_commit) throw new Error('No project or pinned code snapshot.');
    await addDetachedWorktree(project.repo_path, node.worktree_path, node.base_commit);
    // Mark immediately: later failures must preserve this checkout, never replace it.
    store.markAllocated(node.id, true);
  }
  const workingDir = workDirIn(node.worktree_path, project.work_dir);
  if (workingDir !== node.worktree_path) await mkdir(workingDir, { recursive: true });
  return project.source_path === null
    ? []
    : await seedFiles({
        sourceDir: project.source_path,
        targetDir: node.worktree_path,
        files: store.projectView(project).setup.copyFiles,
      });
}

/**
 * The directory Bonsai keeps this project's own files in.
 *
 * For a created project that is where the bare repo lives, read off the repo
 * path itself so it stays right even if the repositories root is later moved.
 * For an adopted one the repo path is the USER'S folder, so it says nothing
 * about where Bonsai put the node worktrees; the project's pinned scratch path answers -- with a paranoid check that the answer is not, by
 * some misconfiguration, inside the user's directory after all.
 */
function bonsaiDirectoryFor(store: Store, project: ProjectRow): string | null {
  if (project.source_kind !== 'adopted') return dirname(project.repo_path);
  const scratch = store.projectScratchDir(project.id);
  if (project.source_path !== null && isInside(project.source_path, scratch)) return null;
  return scratch;
}

/**
 * Whether Bonsai may remove this node's worktree directory.
 *
 * An adopted project's master worktree IS the user's own folder. Bonsai created
 * every other worktree and may remove them; it must never remove that one.
 */
export function ownsWorktree(project: ProjectRow, node: NodeRow): boolean {
  if (project.source_kind !== 'adopted') return true;
  return resolve(node.worktree_path) !== resolve(project.source_path ?? ' ');
}

/**
 * Whether Bonsai may delete this branch.
 *
 * This is the dangerous one, and the reason it is a function rather than a
 * comparison. An adopted project's root branch is the user's own -- `main`,
 * `develop`, whatever they had checked out. The previous delete path refused
 * only a branch literally named "master", so against an adopted repository it
 * would have run `git branch -D main` over real work.
 *
 * The rule is now positive rather than exclusionary: Bonsai deletes a branch
 * only when it is one Bonsai creates, and those are always `node/<uuid>`.
 */
function ownsBranch(project: ProjectRow, node: NodeRow): boolean {
  const branch = node.branch_name;
  if (branch === null) return false;
  if (branch === project.protected_branch) return false;
  if (project.source_kind === 'created' && branch === DEFAULT_BRANCH) return false;
  return branch === branchNameFor(node.id);
}

/**
 * Delete cascades to descendants and removes their branches and worktrees
 * (PRD 6.7) -- but only the ones Bonsai created.
 */
export async function deleteNodeTree(store: Store, nodeId: string): Promise<number> {
  const node = store.getNode(nodeId);
  if (node === undefined) return 0;
  const project = store.getProject(node.project_id);
  if (project === undefined) return 0;

  // Collect before deleting: the rows are gone once the cascade fires.
  const doomed = store.descendantsOf(nodeId);

  for (const row of doomed) await verifyDeletion(project, row);
  for (const row of doomed) {
    if (ownsWorktree(project, row)) {
      await removeWorktree(project.repo_path, row.worktree_path);
    }
    if (ownsBranch(project, row)) {
      await deleteBranch(project.repo_path, row.branch_name!);
    }
    await deleteNodeRef(project, row);
  }

  for (const row of doomed)
    for (const run of store.listRuns(row.id)) {
      await rm(join(store.projectScratchDir(project.id), 'run-context', run.id), {
        recursive: true,
        force: true,
      });
    }
  store.deleteNode(nodeId);
  return doomed.length;
}

/**
 * Deletes a project.
 *
 * For one Bonsai created this means everything: the bare repo and every
 * worktree live under a single directory Bonsai owns, and a bare row delete
 * used to leave all of it orphaned on disk.
 *
 * FOR AN ADOPTED PROJECT IT MEANS MUCH LESS, and the asymmetry is the point.
 * The repository belongs to the user. Bonsai removes the worktrees and the
 * `node/<uuid>` branches it created, and leaves their folder, their history and
 * their branch exactly as it found them. Deleting a Bonsai project must never
 * be a way to lose a real repository.
 */
export async function deleteProjectTree(
  store: Store,
  projectId: string,
): Promise<{ nodes: number; removedDirectory: string | null; keptDirectory: string | null }> {
  const project = store.getProject(projectId);
  if (project === undefined) return { nodes: 0, removedDirectory: null, keptDirectory: null };

  const nodes = store.listNodes(projectId);

  for (const node of nodes) await verifyDeletion(project, node);
  for (const node of nodes) {
    if (ownsWorktree(project, node)) {
      await removeWorktree(project.repo_path, node.worktree_path);
    }
    if (project.source_kind === 'adopted' && ownsBranch(project, node)) {
      await deleteBranch(project.repo_path, node.branch_name!);
    }
  }

  if (project.source_kind === 'adopted') {
    // Every ref of this project, including any no node names any more. Only
    // `refs/bonsai/<project>/`, which nothing but Bonsai writes.
    if (await pathExists(project.repo_path)) await deleteProjectRefs(project.repo_path, project.id);
    // Their repository stays. Bonsai's own folder for this project -- which
    // held the node worktrees and nothing else -- does not; leaving it behind
    // was a slow disk leak and, worse, made "deleted" mean two different
    // things depending on how the project started.
    const scratch = bonsaiDirectoryFor(store, project);
    if (scratch !== null) await rm(scratch, { recursive: true, force: true });
    store.deleteProject(projectId);
    return { nodes: nodes.length, removedDirectory: null, keptDirectory: project.source_path };
  }

  // The bare repo and the internal worktrees sit under one directory Bonsai
  // owns. Master's checkout may have been placed elsewhere, at a folder the
  // user chose -- Bonsai created that folder too (prepareNewDirectory refuses
  // to reuse an existing one), so it goes as well.
  const internal = bonsaiDirectoryFor(store, project) ?? dirname(project.repo_path);
  const checkout =
    project.source_path !== null && !isInside(internal, project.source_path)
      ? project.source_path
      : null;

  await rm(internal, { recursive: true, force: true });
  if (checkout !== null) await rm(checkout, { recursive: true, force: true });

  store.deleteProject(projectId);
  return {
    nodes: nodes.length,
    // The path worth naming is the one the user has seen.
    removedDirectory: checkout ?? internal,
    keptDirectory: null,
  };
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + '/');
}

/**
 * What deleting a project would destroy. The confirmation has to be able to
 * say "your folder stays" and mean it, which is only knowable here.
 */
export function projectDeletionImpact(
  store: Store,
  projectId: string,
): {
  nodes: number;
  costUsd: number;
  commits: number;
  removesDirectory: string | null;
  removesDirectories: string[];
  keepsDirectory: string | null;
  branches: number;
} | null {
  const project = store.getProject(projectId);
  if (project === undefined) return null;
  const nodes = store.listNodes(projectId);

  const adopted = project.source_kind === 'adopted';
  const internal = bonsaiDirectoryFor(store, project) ?? dirname(project.repo_path);

  return {
    nodes: nodes.length,
    costUsd: store.projectCost(projectId),
    commits: nodes.filter((n) => n.head_commit !== null).length,
    removesDirectory: adopted
      ? null
      : project.source_path !== null && !isInside(internal, project.source_path)
        ? project.source_path
        : internal,
    removesDirectories: adopted
      ? bonsaiDirectoryFor(store, project) === null
        ? []
        : [internal]
      : [
          internal,
          ...(project.source_path !== null && !isInside(internal, project.source_path)
            ? [project.source_path]
            : []),
        ],
    keepsDirectory: adopted ? project.source_path : null,
    branches: adopted ? nodes.filter((n) => ownsBranch(project, n)).length : 0,
  };
}

/** Check the whole deletion set before changing anything. External drift is preserved. */
async function verifyDeletion(project: ProjectRow, node: NodeRow): Promise<void> {
  // Every node's, the user's own folder included: the ref is Bonsai's either way.
  if (await pathExists(project.repo_path)) {
    const pinned = await readRef(project.repo_path, nodeRef(project.id, node.id));
    if (pinned !== null && pinned !== tipOf(node))
      throw new OperationConflict(
        'An experiment’s saved code changed outside Bonsai. Nothing was deleted.',
      );
  }
  if (!ownsWorktree(project, node)) return;
  const branch = branchOf(node);
  if (
    branch !== null &&
    branch !== branchNameFor(node.id) &&
    !(project.source_kind === 'created' && node.parent_id === null && branch === DEFAULT_BRANCH)
  ) {
    throw new OperationConflict(
      'This branch is not owned by this Bonsai node. Nothing was deleted.',
    );
  }
  const expected = await expectedGitState(project.repo_path, node);
  if (await pathExists(node.worktree_path)) await assertGitState(node.worktree_path, expected);
  if (branch !== null) {
    const head = await gitLine(
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      project.repo_path,
    );
    if (head !== expected.head)
      throw new OperationConflict(
        'The recorded branch changed outside Bonsai. Nothing was deleted.',
      );
  }
}

/** Removes a node's ref, which verifyDeletion found at its tip or missing. */
async function deleteNodeRef(project: ProjectRow, node: NodeRow): Promise<void> {
  const tip = tipOf(node);
  if (tip === null || !(await pathExists(project.repo_path))) return;
  await deleteRef(project.repo_path, nodeRef(project.id, node.id), tip);
}

/**
 * Gives every node that has none a ref: nodes made before refs existed.
 *
 * Run at startup, and cheap after the first time -- one listing per project.
 * The nodes this matters most for are exactly the ones nothing else would
 * reach: saved for later or archived, with no folder and no run coming.
 * Failures are logged and skipped; a run or an archive of that node pins it
 * again, and reports what is wrong there.
 */
export async function pinExistingNodes(store: Store, log: Logger): Promise<number> {
  let pinned = 0;
  for (const project of store.listProjects()) {
    try {
      if (!(await pathExists(project.repo_path))) continue;
      const refs = await projectRefs(project.repo_path, project.id);
      for (const node of store.listNodes(project.id)) {
        if (tipOf(node) === null || refs.has(nodeRef(project.id, node.id))) continue;
        try {
          await pinNode(project.repo_path, node);
          pinned += 1;
        } catch (error) {
          log.warn('node.pin_failed', {
            projectId: project.id,
            nodeId: node.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      log.warn('project.pin_failed', {
        projectId: project.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return pinned;
}
