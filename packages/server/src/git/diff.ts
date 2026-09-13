import { EMPTY_TREE_SHA } from './repo.js';
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
  headCommit = 'HEAD',
): Promise<NodeDiff> {
  const dirty = (await status(worktreePath)).map((e) => e.path).sort();

  if (!hasCommits) {
    return { files: [], patch: '', dirty };
  }

  const compared = await runDiff(worktreePath, baseCommit, headCommit);

  return {
    files: compared.files,
    patch: compared.patch,
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
  const options = [
    '-c',
    'core.quotepath=false',
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
  ];
  const names = await git(
    [...options, '--name-only', '-z', baseCommit, headCommit, '--'],
    worktreePath,
  );
  return {
    files: names.split('\0').filter(Boolean),
    patch: await git([...options, baseCommit, headCommit, '--'], worktreePath),
    dirty: [],
  };
}

/** Git history is authoritative even for the first root run or equal timestamps. */
export async function parentSnapshot(path: string, commit: string): Promise<string> {
  const history = (await git(['rev-list', '--parents', '-n', '1', commit], path))
    .trim()
    .split(/\s+/);
  return history[1] ?? EMPTY_TREE_SHA;
}
