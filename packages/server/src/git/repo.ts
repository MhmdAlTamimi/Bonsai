import { mkdir } from 'node:fs/promises';
import { git, gitLine } from './exec.js';

export const DEFAULT_BRANCH = 'master';

/**
 * Creates a project's repository.
 *
 * Bare, with every node -- master included -- getting its own worktree. A
 * non-bare repo has one branch checked out in its main working copy, and
 * `git worktree add` refuses a branch that is already checked out somewhere;
 * going bare removes master's special case entirely and answers Open Question 1
 * in favour of uniformity (D17, D26: every node has a cwd).
 *
 * THE ROOT COMMIT IS THE TERMINATION INVARIANT. A worktree cannot be created on
 * an unborn branch, so master must have a commit before its worktree exists.
 * Writing an empty root commit here is what makes the lineage walk total for
 * every node in the tree, and it is also why D21's "'do nothing' is a valid
 * instruction and still produces a repo with an initial commit" is true by
 * construction rather than by the agent's cooperation.
 */
export async function createRepo(repoPath: string): Promise<{ rootCommit: string }> {
  await mkdir(repoPath, { recursive: true });
  await git(['init', '--bare', '--initial-branch=' + DEFAULT_BRANCH, '.'], repoPath);

  // The empty tree, via plumbing -- there is no working copy to commit from.
  const emptyTree = await gitLine(['hash-object', '-t', 'tree', '/dev/null'], repoPath);
  const rootCommit = await gitLine(
    ['commit-tree', emptyTree, '-m', 'Initialise project'],
    repoPath,
  );
  await git(['update-ref', `refs/heads/${DEFAULT_BRANCH}`, rootCommit], repoPath);

  return { rootCommit };
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

export async function commitExists(repoPath: string, commit: string): Promise<boolean> {
  try {
    await git(['cat-file', '-e', `${commit}^{commit}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

/** D33: branch names are generated once from the node id and never shown. */
export function branchNameFor(nodeId: string): string {
  return `node/${nodeId}`;
}
