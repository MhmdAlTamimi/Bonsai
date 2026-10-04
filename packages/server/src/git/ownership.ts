import { resolve } from 'node:path';
import { OperationConflict } from '../domain/errors.js';
import { gitLine } from './exec.js';
import { branchOf, nodeRef, readRef, tipOf } from './refs.js';
import { samePath } from '../paths.js';

export interface GitState {
  head: string;
  branch: string | null;
  commonDir: string;
  /** The node's own ref, which must point at `head`. What readGitState reads has none. */
  ref?: string;
}

export async function readGitState(path: string): Promise<GitState> {
  const head = await gitLine(['rev-parse', 'HEAD'], path);
  const branch = await gitLine(['branch', '--show-current'], path);
  const commonDir = await gitLine(
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    path,
  );
  return { head, branch: branch || null, commonDir: resolve(commonDir) };
}

/** A cooperative integrity check, not a sandbox. Never repair drift by resetting user work. */
export async function assertGitState(path: string, expected: GitState): Promise<void> {
  const actual = await readGitState(path);
  if (
    actual.head !== expected.head ||
    actual.branch !== expected.branch ||
    !samePath(actual.commonDir, expected.commonDir) ||
    // Refs are shared by every worktree of a repository, so the node's own
    // folder reads the same ref the repository does.
    (expected.ref !== undefined && (await readRef(path, expected.ref)) !== expected.head)
  ) {
    throw new OperationConflict(
      'This experiment’s Git state changed outside Bonsai. Work is preserved. Open its panel to import the changes or restore its saved state.',
    );
  }
}

export async function expectedGitState(
  repoPath: string,
  node: {
    id: string;
    project_id: string;
    head_commit: string | null;
    base_commit: string | null;
    branch_name: string | null;
  },
): Promise<GitState> {
  const head = tipOf(node);
  if (head === null) throw new OperationConflict('This experiment has no recorded code snapshot.');
  return {
    head,
    // Detached, unless this node's checkout is on a branch of its own.
    branch: branchOf(node),
    commonDir: resolve(
      await gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath),
    ),
    ref: nodeRef(node.project_id, node.id),
  };
}
