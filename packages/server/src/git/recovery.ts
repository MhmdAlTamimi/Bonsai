import type { RecoveryCause } from '@bonsai/shared';

import { git, gitPatch, status } from './exec.js';
import { CONTEXT_FILE } from './commit.js';

/**
 * Interrupted-run recovery (§6.6 / D31).
 *
 * Closing the app kills the SDK subprocess, leaving a dirty worktree and no
 * commit. The node is marked `interrupted` on the next start, and the user gets
 * resume / discard / keep.
 */

export interface WorktreeState {
  /** Paths with uncommitted changes, CONTEXT.md included. */
  changed: string[];
  /** Files that exist only in the worktree -- invisible to plain `git diff`. */
  untracked: string[];
  /** The patch for tracked changes. Untracked files are described separately. */
  patch: string;
}

/**
 * What the worktree currently holds.
 *
 * D31 is explicit about the trap and it is worth restating at the call site:
 * PLAIN `git diff` MISSES UNTRACKED FILES, so a file the agent created before
 * being killed would be invisible -- and a newly created file is the single
 * most likely thing an interrupted run left behind. `git status --porcelain`
 * sees them, so both are read and the untracked ones are listed by name.
 */
export async function readWorktreeState(worktreePath: string): Promise<WorktreeState> {
  const entries = await status(worktreePath);
  return {
    changed: entries.map((e) => e.path).sort(),
    untracked: entries
      .filter((e) => e.untracked)
      .map((e) => e.path)
      .sort(),
    patch: await boundedPatch(
      ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
      worktreePath,
    ),
  };
}

/**
 * What the agent is told happened, by cause (D45).
 *
 * Never "interrupted" about a run that finished: an agent told it was
 * interrupted believes it, and one that had in fact finished -- while a
 * process it started kept writing -- stopped instead of looking at the files.
 */
function opening(cause: RecoveryCause, error: string | null): string {
  switch (cause) {
    case 'stopped':
      return 'The user stopped your previous run before it finished, and has now asked you to continue it.';
    case 'failed':
      return error === null || error.trim() === ''
        ? 'Your previous run failed before it finished.'
        : `Your previous run failed before it finished, with this error: ${error.trim().slice(0, 500)}`;
    case 'app_closed':
      return 'Bonsai closed while your previous run was in progress, so the run stopped before it finished.';
    case 'changed_after_finish':
      return (
        'Your previous run finished and its work was committed, but files in the working ' +
        'directory changed after it ended -- most likely a process that run started kept ' +
        'writing. Those changes have not been committed.'
      );
  }
}

/**
 * The prompt used to continue from uncommitted work.
 *
 * §6.6: the agent knows what it INTENDED, not what actually landed -- its
 * session ends at the last message it sent, which may be before the write that
 * was cut off. So the app runs the diff for it and injects the result. Without
 * this the agent would redo work that already exists, or assume work exists
 * that does not.
 */
export function resumePrompt(
  state: WorktreeState,
  originalPrompt: string,
  cause: RecoveryCause,
  error: string | null = null,
): string {
  const afterFinish = cause === 'changed_after_finish';
  if (state.changed.length === 0) {
    return afterFinish
      ? `${opening(cause, error)}\n\nThe working directory has no uncommitted changes now, so ` +
          'there is nothing to review. Say so briefly.'
      : `${opening(cause, error)} The working directory has no uncommitted changes — nothing ` +
          `you did was saved.\n\nPlease start again from the beginning:\n\n${originalPrompt}`;
  }

  const lines = [opening(cause, error)];
  if (!afterFinish) {
    lines.push(
      'You may have been part-way through a change, and your own memory of it ends at your',
      'last message — which is not necessarily where the work stopped.',
    );
  }
  lines.push(
    '',
    'Here is the ACTUAL state of the working directory right now, which is the',
    'authoritative record of what landed:',
    '',
    `Files with uncommitted changes (${state.changed.length}):`,
    ...state.changed.map((f) => `  ${f}`),
  );

  if (state.untracked.length > 0) {
    lines.push(
      '',
      'Of those, these are new files that did not exist before:',
      ...state.untracked.map((f) => `  ${f}`),
    );
  }

  if (state.patch.trim() !== '') {
    lines.push('', 'Diff of the tracked changes:', '', '```diff', state.patch.trim(), '```');
  }

  if (afterFinish) {
    lines.push(
      '',
      'Review these changes. Check whether they are the complete, correct output of the work --',
      'for example results a job finished writing -- or something left half-written. Finish',
      'anything incomplete and update CONTEXT.md to describe the results. Do not redo work that',
      'is already present.',
      '',
      'For context, the task was:',
    );
  } else {
    lines.push(
      '',
      'Read whatever you need to confirm the current state before changing anything,',
      'then finish the original task. Do not redo work that is already present.',
      '',
      'The original task was:',
    );
  }
  lines.push('', originalPrompt);
  return lines.join('\n');
}

/**
 * §6.6: discard runs `git checkout .`
 *
 * Extended to untracked files, because `git checkout .` alone leaves them
 * behind -- the same blind spot as above, and "discard" that silently keeps
 * half the changes would be worse than not offering it. CONTEXT.md is included:
 * a partial one describes work that is being thrown away.
 */
export async function discardWorktreeChanges(worktreePath: string): Promise<void> {
  const entries = await status(worktreePath);
  if (entries.length === 0) return;

  const tracked = entries.filter((e) => !e.untracked);
  if (tracked.length > 0) {
    await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.'], worktreePath);
  }
  if (entries.some((e) => e.untracked)) {
    await git(['clean', '-fd'], worktreePath);
  }
}

/** Whether a worktree holds anything worth recovering. */
export async function isDirty(worktreePath: string): Promise<boolean> {
  return (await status(worktreePath)).length > 0;
}

export { CONTEXT_FILE };

async function boundedPatch(args: string[], path: string): Promise<string> {
  const { patch, truncated } = await gitPatch(args, path);
  return patch + (truncated ? '\n[Patch truncated; inspect individual files in Review.]\n' : '');
}
