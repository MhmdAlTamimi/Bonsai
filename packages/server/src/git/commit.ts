import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { assertGitState, type GitState } from './ownership.js';
import { OperationConflict } from '../domain/errors.js';

import { git, gitInput, gitLine, status } from './exec.js';
import { parentSnapshot } from './diff.js';
import { pinRef } from './refs.js';

/** D22/D28: a single human-readable record, written by the agent, committed by the app. */
export const CONTEXT_FILE = 'CONTEXT.md';

export interface CommitOutcome {
  /** False when the run changed nothing, which is what makes it conversation-only. */
  committed: boolean;
  commit: string | null;
  /**
   * What the commit landed on, recorded as the node's `branch_name`: the
   * branch its checkout is on, or its ref when it is detached, as every
   * experiment is now.
   */
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
  /** What this commit alone changed, against the commit before it. */
  ownStat: DiffStat | null;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/**
 * Turns whatever a run left in the worktree into either a commit or nothing.
 *
 * This is where the emergent model actually happens. A node has no commit
 * until this function decides it earned one, so `creates_branch` is an outcome
 * and the lineage walk's "pass through a node with no commit" clause is
 * exercised on every conversation-only run rather than once in the demo.
 *
 * NO BRANCH IS CREATED. An experiment commits on its detached checkout and the
 * commit is kept by the node's ref, which moves with it: a branch would show
 * in the user's `git branch` and go out with their `git push --all`, and would
 * keep nothing the ref does not. A checkout that is on a branch -- master, or
 * an experiment from before this -- commits onto it as it always did.
 *
 * CONTEXT.md IS EXCLUDED FROM THE CHANGE TEST BUT INCLUDED IN THE COMMIT.
 *
 * D28 has the agent write CONTEXT.md as its final action on every run. Counted
 * as a change, that would make every run commit, every node get a commit, and
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
  /** The branch the checkout is on (`branchOf`), or null when it is detached. */
  branchName: string | null;
  /** The node's own ref (`nodeRef`). It moves to every commit made here. */
  ref: string;
  message: string;
  /** Written as CONTEXT.md if the run changed files and the agent wrote none. */
  fallbackContext?: string;
  /** The node's pinned base, to measure the cumulative change against. */
  baseCommit?: string | null;
  expectedState?: GitState;
  contextFile?: string;
  /** Durable save intent, recorded before HEAD or the node's ref can move. */
  prepareSave?: (before: string, outcome: CommitOutcome) => Promise<void>;
}): Promise<CommitOutcome> {
  const { worktreePath, branchName, message } = opts;

  if (opts.expectedState) await assertGitState(worktreePath, opts.expectedState);
  if ((await currentBranch(worktreePath)) !== branchName) {
    throw new OperationConflict('The experiment is on an unexpected branch. Work is preserved.');
  }
  const contextFile = opts.contextFile ?? CONTEXT_FILE;
  const entries = await status(worktreePath);
  // The recorded notes file belongs to Bonsai even when the repository ignores
  // its directory. Preserve the agent's text; do not replace it with fallback notes.
  if (
    !entries.some((entry) => entry.path === contextFile) &&
    existsSync(join(worktreePath, contextFile)) &&
    !(await isTracked(worktreePath, contextFile))
  )
    entries.push({ code: '??', path: contextFile, untracked: true });
  const changed = entries.filter((e) => e.path !== contextFile);

  if (changed.length === 0) {
    await revertContextFile(worktreePath, entries, contextFile);
    return {
      committed: false,
      commit: null,
      branch: null,
      changedPaths: [],
      stat: null,
      ownStat: null,
    };
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
  if (opts.fallbackContext !== undefined && !entries.some((e) => e.path === contextFile)) {
    const tracked = await isTracked(worktreePath, contextFile);
    if (!tracked) {
      await mkdir(dirname(join(worktreePath, contextFile)), { recursive: true });
      await writeFile(join(worktreePath, contextFile), opts.fallbackContext, {
        encoding: 'utf8',
        flag: 'wx',
      }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    }
  }

  if (opts.expectedState) await assertGitState(worktreePath, opts.expectedState);

  // The node's ref must be where this commit's parent is before anything is
  // written. Made here when missing: that only adds protection.
  const before = await gitLine(['rev-parse', 'HEAD'], worktreePath);
  if ((await pinRef(opts.repoPath, opts.ref, before)) !== before)
    throw new OperationConflict(
      'The experiment’s saved code moved outside Bonsai. Work is preserved.',
    );

  // `git add -A` rather than a path list: it stages deletions and untracked
  // files alike, which a path list assembled from a diff would miss (D31).
  await git(['add', '-A'], worktreePath);
  if (existsSync(join(worktreePath, contextFile)))
    await git(['add', '--force', '--', contextFile], worktreePath);
  const tree = await gitLine(['write-tree'], worktreePath);
  const commit = await gitLine(['commit-tree', tree, '-p', before, '-m', message], worktreePath);
  const parent = await parentSnapshot(worktreePath, commit);
  if (opts.expectedState) {
    if (parent !== opts.expectedState.head)
      throw new OperationConflict(
        'The saved commit has an unexpected parent. Work is preserved for inspection.',
      );
  }
  const ownStat = await diffStat(worktreePath, parent, commit);

  const outcome: CommitOutcome = {
    committed: true,
    commit,
    branch: branchName ?? opts.ref,
    changedPaths: changed.map((e) => e.path).sort(),
    // Measured HERE, once, while git is already open on this worktree. Doing
    // it while building the tree view would mean shelling out per node on
    // every refetch, which happens after every run of every sibling.
    //
    // No base means this is the node's FIRST commit -- master starts with
    // none, and the caller pins one from this commit's parent afterwards -- so
    // what this commit changed is also the whole of what the node changed.
    stat: opts.baseCommit == null ? ownStat : await diffStat(worktreePath, opts.baseCommit, commit),
    ownStat,
  };
  await opts.prepareSave?.(before, outcome);
  if (opts.expectedState) await assertGitState(worktreePath, opts.expectedState);
  await advanceCommit(worktreePath, branchName, opts.ref, before, before, commit);
  if (opts.expectedState)
    await assertGitState(worktreePath, { ...opts.expectedState, head: commit });
  return outcome;
}

/** One compare-and-swap transaction moves the checkout tip and its protecting ref. */
export async function advanceCommit(
  path: string,
  branch: string | null,
  ref: string,
  beforeHead: string,
  beforeRef: string | null,
  after: string,
): Promise<void> {
  const headRef = branch === null ? 'HEAD' : `refs/heads/${branch}`;
  await gitInput(
    ['update-ref', '--stdin'],
    path,
    `option no-deref\nstart\nupdate ${headRef} ${after} ${beforeHead}\nupdate ${ref} ${after} ${beforeRef ?? ''}\nprepare\ncommit\n`,
  );
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
  contextFile: string,
): Promise<void> {
  const context = entries.find((e) => e.path === contextFile);
  if (context === undefined) return;

  if (context.untracked) {
    await git(['clean', '-fx', '--', contextFile], worktreePath);
  } else {
    await git(['restore', '--', contextFile], worktreePath);
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
