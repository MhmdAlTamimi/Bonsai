import type { PermissionMode } from '@bonsai/shared';

import type { Store } from './db/store.js';
import { DEFAULT_BRANCH, branchNameFor, createRepo } from './git/repo.js';
import { addBranchWorktree, addDetachedWorktree, deleteBranch, removeWorktree } from './git/worktree.js';
import { resolveBaseCommit } from './domain/lineage.js';
import { toLineage } from './db/store.js';

/**
 * The flows that need git and the database to agree. Kept out of the router so
 * the HTTP layer stays a thin translation of the contract.
 */

export async function createProject(
  store: Store,
  input: {
    name: string;
    description: string;
    model: string | null;
    permissionMode: PermissionMode;
    effort?: string | null;
  },
): Promise<{ projectId: string; masterNodeId: string }> {
  const project = store.createProject(input);
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
  });

  await addBranchWorktree(project.repo_path, master.worktree_path, DEFAULT_BRANCH);
  return { projectId: project.id, masterNodeId: master.id };
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
  },
): Promise<{ nodeId: string; baseCommit: string }> {
  const project = store.getProject(input.projectId);
  if (project === undefined) throw new Error('no such project');
  const parent = store.getNode(input.parentId);
  if (parent === undefined) throw new Error('no such parent node');

  // Computed here as well as inside createNode so the value that reaches git is
  // provably the same one that reaches the database.
  const baseCommit = resolveBaseCommit(toLineage(parent));

  const node = store.createNode(input);
  await addDetachedWorktree(project.repo_path, node.worktree_path, baseCommit);

  return { nodeId: node.id, baseCommit };
}

/** §6.7: delete cascades to descendants and removes their branches and worktrees. */
export async function deleteNodeTree(store: Store, nodeId: string): Promise<number> {
  const node = store.getNode(nodeId);
  if (node === undefined) return 0;
  const project = store.getProject(node.project_id);
  if (project === undefined) return 0;

  // Collect before deleting: the rows are gone once the cascade fires.
  const doomed = store.descendantsOf(nodeId);

  for (const row of doomed) {
    await removeWorktree(project.repo_path, row.worktree_path);
    if (row.branch_name !== null && row.branch_name !== DEFAULT_BRANCH) {
      await deleteBranch(project.repo_path, row.branch_name);
    } else if (row.branch_name === null) {
      // A node that never committed still has no branch to remove, but the
      // name it *would* have taken is deterministic, so clean up defensively.
      await deleteBranch(project.repo_path, branchNameFor(row.id));
    }
  }

  store.deleteNode(nodeId);
  return doomed.length;
}
