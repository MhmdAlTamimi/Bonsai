/**
 * Lineage — where a new node's git base comes from.
 *
 * This is the subtlest logic in the product (PRD §4). It is deliberately pure:
 * no database handle, no git, no filesystem, no agent. Everything it needs
 * arrives as a plain lookup function, which is what lets the M2 checkpoint be a
 * unit test instead of a manual git session.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 *
 * A node's git base is the nearest ancestor that has a commit -- never
 * `parent.commit`. A node that ran but changed no files has no branch and no
 * commit of its own, so the walk must pass straight through it. Under the
 * emergent model this is the normal case, not an edge case: every node's
 * worktree starts detached at its base, and a branch is created only if the run
 * actually changed something.
 *
 * There are two functions here and they are NOT interchangeable:
 *
 *   resolveBaseCommit()      the pinned form. One hop. What node creation calls.
 *   liveNearestAncestorCommit()  the recursive definition. Diagnostics + tests.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PIN EXISTS
 *
 * The recursive walk is time-dependent. Freezing a node on child creation used
 * to make `head_commit` immutable, which made the walk stable by accident. Now
 * that a node freezes only once a child has *committed*, an ancestor can commit
 * after a descendant already exists, and a live walk would silently move that
 * descendant's base:
 *
 *      t1  P.head = c1;  E created under P (commitless), pinned to c1
 *      t2  user chats P again  ->  P.head = c2
 *      t3  F created under E.  Live walk: E(null) -> P(c2).  F lands on c2.
 *
 * That is wrong twice over. F's base would depend on *when* it was created, and
 * worse, F inherits E's conversation -- a conversation grounded in c1's code --
 * while sitting on c2. Code lineage and context lineage would disagree by
 * accident, which is the opposite of the deliberate divergence in PRD §4.
 *
 * So the walk's result is pinned into `base_commit` at creation and read back
 * afterwards. Because each commitless ancestor forwards the pin it was born
 * with, the whole recursion collapses to one hop:
 *
 *      base_commit(new child of P) = P.head_commit ?? P.base_commit
 *
 * The pinned value can therefore disagree with a live walk, and THAT DISAGREEMENT
 * IS THE POINT. Do not "fix" it. `divergesFromLiveWalk()` exists to surface it,
 * and a test asserts it happens.
 *
 * ---------------------------------------------------------------------------
 * TERMINATION INVARIANT
 *
 * `master.head_commit` is non-null from the instant the project row exists.
 * Project creation writes the bare repo's root empty commit and points
 * refs/heads/master at it *before* master's worktree is added -- a worktree
 * cannot be created on an unborn branch, so this is forced by git, not chosen.
 *
 * Consequently `base_commit` is null for exactly one node in any tree (master,
 * which is never a child), and both functions below are total for every child.
 * D21's "'do nothing' still yields a repo with an initial commit" is a
 * consequence of this invariant, not a separate promise the agent has to keep.
 */

/** The only shape lineage needs. A row, minus everything irrelevant. */
export interface LineageNode {
  id: string;
  parentId: string | null;
  /** Pinned at creation. Null for master alone. Immutable once written. */
  baseCommit: string | null;
  /** Null until this node's first commit. Having a branch is NOT sufficient. */
  headCommit: string | null;
}

export type NodeLookup = (id: string) => LineageNode | undefined;

export class LineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineageError';
  }
}

export function lookupFrom(nodes: Iterable<LineageNode>): NodeLookup {
  const byId = new Map<string, LineageNode>();
  for (const n of nodes) byId.set(n.id, n);
  return (id) => byId.get(id);
}

/**
 * The pinned form: what a new child of `parent` branches from.
 *
 * One hop, O(1), stable over time. This is the function node creation calls,
 * and its result is written to the child's `base_commit` and never recomputed.
 */
export function resolveBaseCommit(parent: LineageNode): string {
  const base = parent.headCommit ?? parent.baseCommit;
  if (base === null) {
    throw new LineageError(
      `node ${parent.id} has neither a head commit nor a pinned base; the root ` +
        `commit invariant has been violated (see lineage.ts)`,
    );
  }
  return base;
}

/**
 * The recursive definition: walk strictly upward from `startId`, and return the
 * first ancestor whose `headCommit` is non-null.
 *
 * Deliberately does NOT consult `baseCommit`, so it reports what the tree looks
 * like *right now* rather than what a node was pinned to at birth. Used for
 * diagnostics and to prove the pin agrees with the walk at creation time.
 */
export function liveNearestAncestorCommit(startId: string, lookup: NodeLookup): string {
  const seen = new Set<string>();
  let cursor = lookup(startId);

  if (cursor === undefined) {
    throw new LineageError(`unknown node ${startId}`);
  }

  while (cursor !== undefined) {
    if (seen.has(cursor.id)) {
      throw new LineageError(`cycle in ancestry at node ${cursor.id}`);
    }
    seen.add(cursor.id);

    // A branch is not enough. A node that ran and changed nothing has no
    // commit of its own, so we pass through it -- this is the clause that is
    // easy to get subtly wrong, and under the emergent model it is the norm.
    if (cursor.headCommit !== null) return cursor.headCommit;

    if (cursor.parentId === null) {
      throw new LineageError(
        `walked to the root without finding a commit; master must always have ` +
          `one (see the termination invariant in lineage.ts)`,
      );
    }
    const next = lookup(cursor.parentId);
    if (next === undefined) {
      throw new LineageError(`node ${cursor.id} references missing parent ${cursor.parentId}`);
    }
    cursor = next;
  }

  throw new LineageError(`walk from ${startId} terminated without a commit`);
}

/** Every ancestor of `startId`, nearest first. Excludes the node itself. */
export function ancestors(startId: string, lookup: NodeLookup): LineageNode[] {
  const out: LineageNode[] = [];
  const seen = new Set<string>([startId]);
  let cursor = lookup(startId);
  while (cursor?.parentId != null) {
    if (seen.has(cursor.parentId)) throw new LineageError(`cycle in ancestry at ${cursor.parentId}`);
    seen.add(cursor.parentId);
    const parent = lookup(cursor.parentId);
    if (parent === undefined) {
      throw new LineageError(`node ${cursor.id} references missing parent ${cursor.parentId}`);
    }
    out.push(parent);
    cursor = parent;
  }
  return out;
}

/**
 * Whether a node's pinned base still matches a live walk.
 *
 * True means an ancestor committed after this node was created. That is normal
 * and the pin wins; this exists so the panel can say so out loud rather than
 * leaving two different answers to "what am I based on" lying around.
 */
export function divergesFromLiveWalk(node: LineageNode, lookup: NodeLookup): boolean {
  if (node.parentId === null || node.baseCommit === null) return false;
  return node.baseCommit !== liveNearestAncestorCommit(node.parentId, lookup);
}
