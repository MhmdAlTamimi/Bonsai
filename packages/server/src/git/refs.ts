import { OperationConflict } from '../domain/errors.js';
import { git, gitInput } from './exec.js';
import { commitExists } from './repo.js';

/**
 * Hidden refs: what keeps each experiment's code alive in git.
 *
 * Git deletes a commit once nothing it knows about refers to it -- no branch,
 * tag or other ref, no worktree checked out on it, no reflog entry young
 * enough -- and Bonsai's database is not something git knows about. So an
 * experiment starting from a commit on none of the user's branches (a snapshot
 * of uncommitted work, or history they later rewrote) that had no folder of
 * its own (saved for later, or archived) was one `git gc` away from losing its
 * code. Master of an adopted project with a snapshot never had a folder on it
 * at all.
 *
 * So every node has a ref of its own from the moment it exists, pointing at
 * its latest commit, or the one it starts from while it has none: its TIP,
 * `head_commit ?? base_commit`. Under `refs/bonsai/` rather than `refs/heads/`:
 * any ref under `refs/` protects a commit, while `refs/heads/` is the part
 * `git branch`, branch pickers and `push --all` look at. GitHub keeps pull
 * requests under `refs/pull/` for the same reason.
 *
 * Every write names what it expects to find (nothing, or the old commit), and
 * git checks that atomically. A ref that points somewhere Bonsai did not put it
 * is drift, reported rather than repaired, like a branch that moved.
 */
export function nodeRef(projectId: string, nodeId: string): string {
  return `refs/bonsai/${projectId}/${nodeId}`;
}

/** A node's tip: the commit its ref points at. Null only before master has a commit. */
export function tipOf(node: {
  head_commit: string | null;
  base_commit: string | null;
}): string | null {
  return node.head_commit ?? node.base_commit;
}

/** Where a ref points, or null when there is no such ref. */
export async function readRef(repoPath: string, ref: string): Promise<string | null> {
  return (await refsUnder(repoPath, ref)).get(ref) ?? null;
}

/** Every ref under a prefix, and where each points. A prefix ending in `/` matches whole names only. */
async function refsUnder(repoPath: string, prefix: string): Promise<Map<string, string>> {
  const out = await git(['for-each-ref', '--format=%(refname) %(objectname)', prefix], repoPath);
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, commit] = line.trim().split(' ');
    if (name !== undefined && name !== '' && commit !== undefined) refs.set(name, commit);
  }
  return refs;
}

/** A project's refs, and where each points. */
export async function projectRefs(
  repoPath: string,
  projectId: string,
): Promise<Map<string, string>> {
  return refsUnder(repoPath, `refs/bonsai/${projectId}/`);
}

/**
 * Creates a ref at `commit` when there is none, and says where it points
 * either way. Never moves an existing one: when the answer is not `commit`,
 * that is for the caller to refuse.
 *
 * Git refuses to create a ref that already exists, and refuses a commit it
 * does not have -- so a ref is never made pointing at nothing.
 */
export async function pinRef(repoPath: string, ref: string, commit: string): Promise<string> {
  const current = await readRef(repoPath, ref);
  if (current !== null) return current;
  try {
    await git(['update-ref', ref, commit, ''], repoPath);
    return commit;
  } catch (error) {
    // Made by someone else in the meantime: theirs is the answer.
    const made = await readRef(repoPath, ref);
    if (made !== null) return made;
    throw error;
  }
}

/**
 * Makes sure a node's ref exists and points at its tip.
 *
 * A missing ref is created: that only adds protection, whatever the reason it
 * was missing (a node from before refs existed, say). One pointing anywhere
 * else is refused, never moved to match the database.
 */
export async function pinNode(
  repoPath: string,
  node: { id: string; project_id: string; head_commit: string | null; base_commit: string | null },
): Promise<void> {
  const tip = tipOf(node);
  if (tip === null) return;
  let pinned: string;
  try {
    pinned = await pinRef(repoPath, nodeRef(node.project_id, node.id), tip);
  } catch (error) {
    if (!(await commitExists(repoPath, tip))) throw new OperationConflict(missingCode(tip));
    throw error;
  }
  if (pinned !== tip)
    throw new OperationConflict(
      'This experiment’s saved code changed outside Bonsai. Work is preserved. Inspect it with your Git tools; Bonsai will not rewrite it.',
    );
}

/** Said when git no longer has an experiment's code. It cannot be made again. */
export function missingCode(commit: string): string {
  return `This experiment’s code (commit ${commit.slice(0, 7)}) is no longer in the repository, so it cannot be checked out.`;
}

/** Moves a ref to `to`, only if it still points at `from`. */
export async function moveRef(
  repoPath: string,
  ref: string,
  to: string,
  from: string,
): Promise<void> {
  await git(['update-ref', ref, to, from], repoPath);
}

/** Deletes a ref, only if it still points at `expected`. A missing one is already gone. */
export async function deleteRef(repoPath: string, ref: string, expected: string): Promise<void> {
  if ((await readRef(repoPath, ref)) === null) return;
  await git(['update-ref', '-d', ref, expected], repoPath);
}

/**
 * Deletes every ref a project has, in one transaction. Only for a project
 * being deleted, after its nodes' refs were checked: this also takes refs no
 * node row names any more, which nothing else would ever remove.
 */
export async function deleteProjectRefs(repoPath: string, projectId: string): Promise<number> {
  const refs = await projectRefs(repoPath, projectId);
  if (refs.size === 0) return 0;
  // Each delete names the commit it expects, and the transaction is all or
  // nothing: a ref moved since it was listed fails the lot.
  const commands = [...refs].map(([ref, commit]) => `delete ${ref} ${commit}\n`).join('');
  await gitInput(['update-ref', '--stdin'], repoPath, commands);
  return refs.size;
}
