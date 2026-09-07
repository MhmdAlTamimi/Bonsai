import { git, status } from './exec.js';

export interface NodeDiff {
  /** Files this node changed relative to its base commit. */
  files: string[];
  patch: string;
  /** Uncommitted work sitting in the worktree, which M4 turns into recovery. */
  dirty: string[];
}

/**
 * What a node changed, measured against the commit it branched from.
 *
 * Uses the three-dot-free explicit range `base..HEAD` rather than diffing
 * against the parent node, because the parent may have no commit at all -- the
 * base is the pinned commit, and it is the only correct comparison point.
 */
export async function nodeDiff(
  worktreePath: string,
  baseCommit: string,
  hasCommits: boolean,
): Promise<NodeDiff> {
  const dirty = (await status(worktreePath)).map((e) => e.path).sort();

  if (!hasCommits) {
    return { files: [], patch: '', dirty };
  }

  const names = await git(['diff', '--name-only', `${baseCommit}..HEAD`], worktreePath);
  const patch = await git(['diff', `${baseCommit}..HEAD`], worktreePath);

  return {
    files: names.split('\n').filter((l) => l !== ''),
    patch,
    dirty,
  };
}

/**
 * The diff a single run produced.
 *
 * Ranged between the commit the node was on before the run and the commit it
 * produced, so each exchange in the conversation can show exactly what it
 * changed rather than everything the node has ever done.
 */
export async function runDiff(
  worktreePath: string,
  baseCommit: string,
  headCommit: string,
): Promise<NodeDiff> {
  const range = `${baseCommit}..${headCommit}`;
  const names = await git(['diff', '--name-only', range], worktreePath);
  return {
    files: names.split('\n').filter((l) => l !== ''),
    patch: await git(['diff', range], worktreePath),
    dirty: [],
  };
}
