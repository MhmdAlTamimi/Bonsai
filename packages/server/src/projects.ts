import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { PermissionMode } from '@bonsai/shared';

import type { NodeRow, ProjectRow, Store } from './db/store.js';
import { DEFAULT_BRANCH, branchNameFor, createRepo } from './git/repo.js';
import {
  addBranchWorktree,
  addDetachedWorktree,
  deleteBranch,
  removeWorktree,
} from './git/worktree.js';
import { resolveBaseCommit } from './domain/lineage.js';
import { toLineage } from './db/store.js';
import { adoptDirectory, snapshotUncommitted, suggestProjectName } from './git/adopt.js';
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
 *   its existing branch, and nodes are `node/<uuid>` branches inside THEIR
 *   repository. Bonsai may delete only what it created.
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
  },
): Promise<{ projectId: string; masterNodeId: string; path: string }> {
  const project = store.createProject(input);

  // Resolved before anything is created so a bad location fails cleanly, with
  // no repository left behind. The bare repo always stays in Bonsai's own
  // directory; only the checkout is placed where the user asked.
  const chosen =
    input.location === undefined || input.location === null || input.location.trim() === ''
      ? null
      : await prepareNewDirectory(input.location, input.name);

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

  await addBranchWorktree(project.repo_path, master.worktree_path, DEFAULT_BRANCH);
  // Recorded now rather than at insert because the default path contains the
  // node's own id. This is the path "reveal in file manager" opens, for created
  // and adopted projects alike.
  store.setProjectSourcePath(project.id, master.worktree_path);
  return { projectId: project.id, masterNodeId: master.id, path: master.worktree_path };
}

/**
 * Picks the folder a new project's checkout goes in, and refuses to reuse one.
 *
 * Deleting a created project deletes this directory, so it must be one Bonsai
 * made. An existing folder with anything in it is rejected rather than merged
 * into: the alternative is a delete that takes the user's unrelated files with
 * it, and no amount of confirmation text makes that acceptable.
 */
async function prepareNewDirectory(location: string, name: string): Promise<string> {
  const parent = resolve(location);
  if (!existsSync(parent)) throw new Error(`That folder does not exist: ${parent}`);

  const base = slugify(name);
  let target = join(parent, base);
  for (let n = 2; await isNonEmpty(target); n += 1) {
    if (n > 99) throw new Error(`Could not find a free folder name in ${parent}`);
    target = join(parent, `${base}-${n}`);
  }

  await mkdir(target, { recursive: true });
  return target;
}

async function isNonEmpty(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false; // does not exist, or is not readable -- mkdir will decide
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
 * folder; child nodes get worktrees under Bonsai's own directory, on branches
 * inside the user's repository -- so work done in a node is reachable with
 * their ordinary git tools, and Bonsai needs no export feature to hand it back.
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
): Promise<{ projectId: string; masterNodeId: string; initialised: boolean; snapshot: boolean }> {
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
        ? suggestProjectName(adopted.repoPath)
        : input.name,
    description: input.description,
    model: input.model,
    permissionMode: input.permissionMode,
    effort: input.effort ?? null,
    adopt: {
      repoPath: adopted.repoPath,
      sourcePath: adopted.repoPath,
      protectedBranch: adopted.branch,
    },
  });

  const master = store.createNode({
    projectId: project.id,
    parentId: null,
    displayName: adopted.branch,
    description: input.description,
    rootCommit: base,
    rootBranchName: adopted.branch,
    // The user's own directory, not a worktree Bonsai created.
    worktreePath: adopted.repoPath,
  });

  return {
    projectId: project.id,
    masterNodeId: master.id,
    initialised: adopted.initialised,
    snapshot,
  };
}

/**
 * Creates a node and its worktree.
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

  const node = store.createNode(input);
  await addDetachedWorktree(project.repo_path, node.worktree_path, baseCommit);

  /**
   * The worktree is checked out; now give it what git left behind.
   *
   * Copying happens HERE, synchronously, because it is a handful of small
   * files and the node should never be visible without them. The SETUP COMMAND
   * does not: `npm install` on a cold cache takes minutes, and holding the
   * HTTP response open for that would freeze the canvas at the exact moment
   * the user is watching it. It runs instead as the first phase of the node's
   * first run, where it is asynchronous, cancellable and visible -- and still,
   * as required, complete before the agent starts.
   */
  const seeded =
    project.source_path === null
      ? []
      : await seedFiles({
          sourceDir: project.source_path,
          targetDir: node.worktree_path,
          files: store.projectView(project).setup.copyFiles,
        });

  return { nodeId: node.id, baseCommit, seeded };
}

/**
 * The directory Bonsai keeps this project's own files in.
 *
 * For a created project that is where the bare repo lives, read off the repo
 * path itself so it stays right even if the repositories root is later moved.
 * For an adopted one the repo path is the USER'S folder, so it says nothing
 * about where Bonsai put the node worktrees and the configured root is the only
 * thing that can answer -- with a paranoid check that the answer is not, by
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
function ownsWorktree(project: ProjectRow, node: NodeRow): boolean {
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
function ownsBranch(project: ProjectRow, branch: string | null): branch is string {
  if (branch === null) return false;
  if (branch === project.protected_branch) return false;
  if (project.source_kind === 'created' && branch === DEFAULT_BRANCH) return false;
  return branch.startsWith('node/');
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

  for (const row of doomed) {
    if (ownsWorktree(project, row)) {
      await removeWorktree(project.repo_path, row.worktree_path);
    }
    if (ownsBranch(project, row.branch_name)) {
      await deleteBranch(project.repo_path, row.branch_name);
    } else if (row.branch_name === null) {
      // A node that never committed has no branch, but the name it would have
      // taken is deterministic -- and is unambiguously Bonsai's.
      await deleteBranch(project.repo_path, branchNameFor(row.id));
    }
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

  for (const node of nodes) {
    if (ownsWorktree(project, node)) {
      await removeWorktree(project.repo_path, node.worktree_path);
    }
    if (project.source_kind === 'adopted' && ownsBranch(project, node.branch_name)) {
      await deleteBranch(project.repo_path, node.branch_name);
    }
  }

  if (project.source_kind === 'adopted') {
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
    keepsDirectory: adopted ? project.source_path : null,
    branches: adopted ? nodes.filter((n) => ownsBranch(project, n.branch_name)).length : 0,
  };
}
