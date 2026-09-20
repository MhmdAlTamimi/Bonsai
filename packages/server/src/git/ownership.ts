import { resolve } from 'node:path';
import { OperationConflict } from '../domain/errors.js';
import { gitLine } from './exec.js';

export interface GitState {
  head: string;
  branch: string | null;
  commonDir: string;
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
    actual.commonDir !== expected.commonDir
  ) {
    throw new OperationConflict(
      'This experiment’s Git state changed outside Bonsai. Work is preserved. Inspect and preserve unexpected work with your Git tools before restoring the recorded state; Bonsai will not rewrite it.',
    );
  }
}

export async function expectedGitState(
  repoPath: string,
  node: { head_commit: string | null; base_commit: string | null; branch_name: string | null },
): Promise<GitState> {
  const head = node.head_commit ?? node.base_commit;
  if (head === null) throw new OperationConflict('This experiment has no recorded code snapshot.');
  return {
    head,
    branch: node.branch_name,
    commonDir: resolve(
      await gitLine(['rev-parse', '--path-format=absolute', '--git-common-dir'], repoPath),
    ),
  };
}
