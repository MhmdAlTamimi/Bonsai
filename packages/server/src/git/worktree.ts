import { lstat } from 'node:fs/promises';
import { git } from './exec.js';

/**
 * Worktrees separate checkouts, not host permissions. One shared object store, one
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
  } catch (error) {
    // Never replace a failed Git ownership check with recursive deletion.
    try {
      await lstat(worktreePath);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') {
        await git(['worktree', 'prune'], repoPath);
        return;
      }
    }
    throw error;
  }
}

/** Delete only an existing ref; failures (including use by another checkout) matter. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  const refs = await git(['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`], repoPath);
  if (!refs.split('\n').includes(`refs/heads/${branch}`)) return;
  await git(['branch', '-D', branch], repoPath);
}
