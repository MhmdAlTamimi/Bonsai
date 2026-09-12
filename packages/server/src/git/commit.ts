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
  /**
   * How much this NODE has changed since its base, not how much this run did.
   *
   * Cumulative on purpose: it is the number the card should show ("what did
   * this node do"), it matches the diff the panel already displays, and it
   * needs no aggregation across runs -- which would double-count a file edited
   * twice. Null when the run committed nothing.
   */
  stat: DiffStat | null;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
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
  /** The node's pinned base, to measure the cumulative change against. */
  baseCommit?: string | null;
}): Promise<CommitOutcome> {
  const { worktreePath, branchName, message } = opts;

  const entries = await status(worktreePath);
  const changed = entries.filter((e) => e.path !== CONTEXT_FILE);

  if (changed.length === 0) {
    await revertContextFile(worktreePath, entries);
    return { committed: false, commit: null, branch: null, changedPaths: [], stat: null };
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

  const commit = await gitLine(['rev-parse', 'HEAD'], worktreePath);

  return {
    committed: true,
    commit,
    branch: branchName,
    changedPaths: changed.map((e) => e.path).sort(),
    // Measured HERE, once, while git is already open on this worktree. Doing
    // it while building the tree view would mean shelling out per node on
    // every refetch, which happens after every run of every sibling.
    stat: opts.baseCommit == null ? null : await diffStat(worktreePath, opts.baseCommit, commit),
  };
}

/**
 * `--numstat` rather than `--shortstat`, because shortstat's output is prose
 * ("2 files changed, 8 insertions(+)") with pluralisation and omitted clauses,
 * and parsing prose to get three integers is how a display quietly starts
 * showing zeros.
 */
export async function diffStat(cwd: string, from: string, to: string): Promise<DiffStat> {
  const out = await git(['diff', '--numstat', `${from}..${to}`], cwd);
  let files = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const [added, removed] = line.split('\t');
    files += 1;
    // A binary file reports '-' for both. Counted as a changed file, which is
    // true, with no line counts, which is also true.
    insertions += Number(added) || 0;
    deletions += Number(removed) || 0;
  }
  return { files, insertions, deletions };
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
  entries: ReadonlyArray<{ path: string; untracked: boolean }>,
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
