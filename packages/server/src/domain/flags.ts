/**
 * Derived node flags. PRD §9 constraint 4: render from flags, never from a node
 * "type" string.
 *
 * Both flags are computed here on every read rather than stored, so they cannot
 * drift out of step with the tree. Under the emergent model neither one is an
 * input the user supplies:
 *
 *   createsBranch  is an OUTCOME  -- true once a run committed something.
 *   writable       is RETROACTIVE -- false once a child has committed.
 *
 * The `writable = creates_branch && isLeaf` formulation is WRONG and was
 * corrected during planning. A node whose only children changed no files is not
 * a leaf, but is still writable: nothing has branched off its code, so nothing
 * can go stale. `isLeaf` survives as a rendering hint and nothing more.
 */

export interface FlagInput {
  headCommit: string | null;
}

export interface DerivedFlags {
  createsBranch: boolean;
  writable: boolean;
  isLeaf: boolean;
  hasCommits: boolean;
}

export function createsBranch(node: FlagInput): boolean {
  return node.headCommit !== null;
}

/**
 * Writable while no child of this node has committed.
 *
 * Note this is checked at RUN START and never re-checked. A run already in
 * flight is not invalidated by a sibling committing halfway through it --
 * cancelling paid, unreproducible work to honour a freeze that arrived mid-run
 * costs more than it protects, and the child's base is pinned anyway so nothing
 * downstream can go stale.
 */
export function isWritable(children: readonly FlagInput[]): boolean {
  return !children.some((child) => child.headCommit !== null);
}

export function deriveFlags(node: FlagInput, children: readonly FlagInput[]): DerivedFlags {
  return {
    createsBranch: createsBranch(node),
    writable: isWritable(children),
    isLeaf: children.length === 0,
    hasCommits: node.headCommit !== null,
  };
}
