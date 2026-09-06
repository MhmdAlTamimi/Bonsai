import { rm } from 'node:fs/promises';
import { git } from './exec.js';

/**
 * Worktrees are the isolation boundary (D17). One shared object store, one
 * directory per node, and that directory is the agent's cwd.
 *
 * Under the emergent model every node starts DETACHED at its base commit. The
 * branch is just a ref, so it is deferred until the node actually commits
 * something -- which is what makes "did this node write code?" an outcome
 * rather than a question asked up front.
 */
export async function addDetachedWorktree(
  repoPath: string,
  worktreePath: string,
  commit: string,
): Promise<void> {
  await git(['worktree', 'add', '--detach', worktreePath, commit], repoPath);
}

/** Master alone starts attached: D24 makes it a real branch from the outset. */
export async function addBranchWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git(['worktree', 'add', worktreePath, branch], repoPath);
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', worktreePath], repoPath);
  } catch {
    // A worktree whose directory is already gone still leaves administrative
    // state behind; prune it so the path can be reused.
    await rm(worktreePath, { recursive: true, force: true });
    await git(['worktree', 'prune'], repoPath);
  }
}

/** §6.7: deleting a node removes its branch as well as its worktree. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await git(['branch', '-D', branch], repoPath);
  } catch {
    // Already gone, or the node never committed and so never had one.
  }
}
