import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { git, gitLine, status } from './exec.js';

/** D22/D28: a single human-readable record, written by the agent, committed by the app. */
export const CONTEXT_FILE = 'CONTEXT.md';

export interface CommitOutcome {
  /** False when the run changed nothing, which is what makes it conversation-only. */
  committed: boolean;
  commit: string | null;
  branch: string | null;
  /** Paths the run touched, excluding CONTEXT.md. */
  changedPaths: string[];
}

/**
 * Turns whatever a run left in the worktree into either a commit or nothing.
 *
 * This is where the emergent model actually happens. A node has no branch and
 * no commit until this function decides it earned one, so `creates_branch` is
 * an outcome and the lineage walk's "pass through a node with no commit" clause
 * is exercised on every conversation-only run rather than once in the demo.
 *
 * CONTEXT.md IS EXCLUDED FROM THE CHANGE TEST BUT INCLUDED IN THE COMMIT.
 *
 * D28 has the agent write CONTEXT.md as its final action on every run. Counted
 * as a change, that would make every run commit, every node get a branch, and
 * no node ever be conversation-only -- it would silently delete the emergent
 * model. So it records a run; it does not get a vote on whether there was one.
 *
 * When a run changes nothing else, the CONTEXT.md it wrote is reverted rather
 * than left dirty. Left alone it would sit in the worktree and ride into the
 * next run's commit, attributing this run's notes to the next one's changes.
 */
export async function commitRunOutput(opts: {
  repoPath: string;
  worktreePath: string;
  branchName: string;
  message: string;
  /** Written as CONTEXT.md if the run changed files and the agent wrote none. */
  fallbackContext?: string;
}): Promise<CommitOutcome> {
  const { worktreePath, branchName, message } = opts;

  const entries = await status(worktreePath);
  const changed = entries.filter((e) => e.path !== CONTEXT_FILE);

  if (changed.length === 0) {
    await revertContextFile(worktreePath, entries);
    return { committed: false, commit: null, branch: null, changedPaths: [] };
  }

  /**
   * D28 has the agent write CONTEXT.md as its final action, and in practice it
   * sometimes does not -- verified against a real run, where the agent made its
   * change, committed cleanly, and simply skipped the file. An instruction in a
   * system prompt is not a guarantee.
   *
   * D22 wants a human-readable record of what happened to exist, so when the
   * agent leaves none the app writes a plain one from what it knows. The
   * agent's own version is always preferred when there is one.
   */
  if (opts.fallbackContext !== undefined && !entries.some((e) => e.path === CONTEXT_FILE)) {
    const tracked = await isTracked(worktreePath, CONTEXT_FILE);
    if (!tracked) {
      await writeFile(join(worktreePath, CONTEXT_FILE), opts.fallbackContext, 'utf8');
    }
  }

  // Detached until now. Creating the branch here, at the moment of the first
  // commit, is the whole point: the ref is deferred, not chosen up front.
  const onBranch = await currentBranch(worktreePath);
  if (onBranch === null) {
    await git(['switch', '-c', branchName], worktreePath);
  }

  // `git add -A` rather than a path list: it stages deletions and untracked
  // files alike, which a path list assembled from a diff would miss (D31).
  await git(['add', '-A'], worktreePath);
  await git(['commit', '-m', message], worktreePath);

  return {
    committed: true,
    commit: await gitLine(['rev-parse', 'HEAD'], worktreePath),
    branch: branchName,
    changedPaths: changed.map((e) => e.path).sort(),
  };
}

/**
 * Restores CONTEXT.md to its committed state.
 *
 * Two paths, because a node's first run leaves it untracked and every later run
 * leaves it modified. This is D31's untracked-files trap in a different
 * costume, which is why both cases go through one function instead of being
 * remembered at each call site.
 */
async function revertContextFile(
  worktreePath: string,
  entries: readonly { path: string; untracked: boolean }[],
): Promise<void> {
  const context = entries.find((e) => e.path === CONTEXT_FILE);
  if (context === undefined) return;

  if (context.untracked) {
    await git(['clean', '-f', '--', CONTEXT_FILE], worktreePath);
  } else {
    await git(['restore', '--', CONTEXT_FILE], worktreePath);
  }
}

async function isTracked(worktreePath: string, path: string): Promise<boolean> {
  try {
    await git(['ls-files', '--error-unmatch', '--', path], worktreePath);
    return true;
  } catch {
    return false;
  }
}

/** The branch a worktree is on, or null when it is detached. */
export async function currentBranch(worktreePath: string): Promise<string | null> {
  const name = await gitLine(['branch', '--show-current'], worktreePath);
  return name === '' ? null : name;
}

/** D12: the commit message is generated from the node description. */
export function commitMessageFor(displayName: string, description: string): string {
  const summary = displayName.trim() || 'Node update';
  const body = description.trim();
  return body === '' ? summary : `${summary}\n\n${body}`;
}
