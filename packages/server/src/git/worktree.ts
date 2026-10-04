import { lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { OperationConflict } from '../domain/errors.js';
import { git, gitLine, GitError } from './exec.js';
import { initialiseSubmodules } from './submodules.js';

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
  await finishNewWorktree(repoPath, worktreePath);
}

/** Master alone starts attached: D24 makes it a real branch from the outset. */
export async function addBranchWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git(['worktree', 'add', worktreePath, branch], repoPath);
  await finishNewWorktree(repoPath, worktreePath);
}

async function finishNewWorktree(repo: string, path: string): Promise<void> {
  try {
    await initialiseSubmodules(path);
  } catch (error) {
    try {
      await removeWorktree(repo, path);
    } catch (cleanup) {
      throw new Error(
        `Checkout setup failed and cleanup was incomplete. Folder preserved at ${path}. ${String(error)}; ${String(cleanup)}`,
      );
    }
    throw error;
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    if (existsSync(worktreePath)) await assertWorktreeUnlocked(worktreePath);
    try {
      await git(['worktree', 'remove', '--force', worktreePath], repoPath);
    } catch (error) {
      if (!(error instanceof GitError) || !/submodules/i.test(error.stderr)) throw error;
      await assertWorktreeUnlocked(worktreePath);
      await git(['worktree', 'remove', '--force', '--force', worktreePath], repoPath);
    }
  } catch (error) {
    // Never replace a failed Git ownership check with recursive deletion.
    try {
      await lstat(worktreePath);
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code === 'ENOENT') {
        const registered = await git(['worktree', 'list', '--porcelain', '-z'], repoPath);
        if (registered.split('\0').includes(`worktree ${worktreePath}`)) throw error;
        return;
      }
    }
    throw error;
  }
}

/** The second force needed for submodules must never override a user's Git lock. */
export async function assertWorktreeUnlocked(path: string): Promise<void> {
  const lock = await gitLine(['rev-parse', '--path-format=absolute', '--git-path', 'locked'], path);
  if (existsSync(lock))
    throw new OperationConflict(
      'This experiment folder is locked by Git. Unlock the worktree with Git and retry; its files are preserved.',
    );
}

/** Delete only an existing ref; failures (including use by another checkout) matter. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  const refs = await git(['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`], repoPath);
  if (!refs.split('\n').includes(`refs/heads/${branch}`)) return;
  await git(['branch', '-D', branch], repoPath);
}
