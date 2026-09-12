import { git, status } from './exec.js';
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
    patch: await git(['diff'], worktreePath),
  };
}

/**
 * The prompt used to resume an interrupted run.
 *
 * §6.6: the agent knows what it INTENDED, not what actually landed -- its
 * session ends at the last message it sent, which may be before the write that
 * was cut off. So the app runs the diff for it and injects the result. Without
 * this the agent would redo work that already exists, or assume work exists
 * that does not.
 */
export function resumePrompt(state: WorktreeState, originalPrompt: string): string {
  if (state.changed.length === 0) {
    return (
      `Your previous run was interrupted before it finished, and the working ` +
      `directory has no uncommitted changes — nothing you did was saved.\n\n` +
      `Please start again from the beginning:\n\n${originalPrompt}`
    );
  }

  const lines = [
    'Your previous run was interrupted before it finished. You may have been',
    'part-way through a change, and your own memory of it ends at your last',
    'message — which is not necessarily where the work stopped.',
    '',
    'Here is the ACTUAL state of the working directory right now, which is the',
    'authoritative record of what landed:',
    '',
    `Files with uncommitted changes (${state.changed.length}):`,
    ...state.changed.map((f) => `  ${f}`),
  ];

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

  lines.push(
    '',
    'Read whatever you need to confirm the current state before changing anything,',
    'then finish the original task. Do not redo work that is already present.',
    '',
    'The original task was:',
    '',
    originalPrompt,
  );

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
    await git(['checkout', '--', '.'], worktreePath);
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
