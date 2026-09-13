import type { NodeRow, ProjectRow } from '../db/store.js';

/**
 * How to get at a node's branch from a terminal.
 *
 * The payoff of adopting a folder: the winning branch is already sitting in
 * the user's own repository, so the answer is one command they can run where
 * they already are. That is the difference between an interesting viewer and
 * something people ship with.
 *
 * A project Bonsai CREATED is different in a way that matters. Its repository
 * is a bare one in Bonsai's data directory, and `git switch` cannot run there
 * -- a bare repo has no working tree. So the command names that location and
 * clones out of it, which is the smallest thing that actually works.
 */
export function checkoutFor(
  project: ProjectRow | undefined,
  node: NodeRow,
): { command: string; hint: string } | null {
  if (project === undefined || node.branch_name === null) return null;

  if (project.source_kind === 'adopted') {
    /**
     * `git switch -c`, not `git switch`. Found by running it.
     *
     * The node's branch is checked out in Bonsai's own worktree, and git
     * refuses to check the same branch out twice -- so the obvious command
     * fails with a message about a worktree the user did not know existed.
     * Branching from it always works, leaves Bonsai's worktree alone, and is
     * closer to the intent anyway: this is you taking the approach that won.
     */
    return {
      command: `git switch -c ${suggestBranchName(node.display_name)} ${node.branch_name}`,
      hint: `Run this in ${project.source_path ?? 'your project folder'} after saving or committing any work in that checkout. It creates and switches to a new branch from this experiment’s committed code; choose a different new branch name if the suggested name already exists. This does not publish or sync changes, and excludes the experiment’s uncommitted partial work.`,
    };
  }

  return {
    command: `git clone --branch ${node.branch_name} ${shellQuote(project.repo_path)} ${shellQuote(node.display_name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'node')}`,
    hint: `In a terminal, go to the folder where you want the copy, then run this command. It creates a new subfolder named "${node.display_name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'node'}" containing this experiment's committed code. Choose a location where that subfolder does not already exist. This is a local copy, not a publish or sync; uncommitted partial work is excluded.`,
  };
}

/** A branch name from a display name: lowercase, no spaces, nothing git rejects. */
function suggestBranchName(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug === '' ? 'from-bonsai' : slug;
}

/** Single-quoted for POSIX shells, which is where a copied command is pasted. */
function shellQuote(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
