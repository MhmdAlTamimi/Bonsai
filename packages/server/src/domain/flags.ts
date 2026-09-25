/** Child code bases are pinned. Only original adopted checkouts are read-only,
 * enforced by the project-aware view/run boundary. Children never freeze parents. */
export interface FlagInput {
  headCommit: string | null;
}

export interface DerivedFlags {
  createsBranch: boolean;
  isLeaf: boolean;
  hasCommits: boolean;
}

export function createsBranch(node: FlagInput): boolean {
  return node.headCommit !== null;
}

export function deriveFlags(node: FlagInput, children: readonly FlagInput[]): DerivedFlags {
  return {
    createsBranch: createsBranch(node),
    isLeaf: children.length === 0,
    hasCommits: node.headCommit !== null,
  };
}
