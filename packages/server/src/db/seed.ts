import type { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';

/**
 * The PRD §2 demo tree, as five rows with fake commit shas.
 *
 * M1 has no git and no agent, so the commits here are placeholders. The shape
 * is the point: it is the exact tree the demo script produces, and it exercises
 * both of the rules that were corrected during planning.
 *
 *   master  head=c1                          frozen (A committed)
 *     |- A   base=c1  head=c2                WRITABLE despite having a child,
 *     |    |                                 because E committed nothing
 *     |    \- E  base=c2  head=null          ran, changed nothing -> no branch
 *     |         \- F  base=c2  head=c3       skips E in git, inherits its session
 *     \- B   base=c1  head=c4                writable leaf
 *
 * A is the interesting row: `writable = creates_branch && isLeaf` would have
 * frozen it. F is the other: its base is A's commit, not E's absence of one.
 */
export function seedDemoProject(db: DatabaseSync, reposRoot: string): string {
  const store = new Store(db, reposRoot);

  const project = store.createProject({
    name: 'todo-cli',
    description: 'A small Python CLI for managing a todo list.',
    model: null,
    permissionMode: 'acceptEdits',
  });

  const commit = (row: { id: string }, sha: string, branch: string): void => {
    db.prepare(`UPDATE node SET head_commit = ?, branch_name = ?, status = 'ready' WHERE id = ?`).run(
      sha,
      branch,
      row.id,
    );
  };
  const ready = (row: { id: string }): void => store.setNodeStatus(row.id, 'ready');

  // D24: master is a real git branch, and the root commit exists before its
  // worktree does. Everything below depends on that invariant.
  const master = store.createNode({
    projectId: project.id,
    parentId: null,
    displayName: 'master',
    description: 'Scaffold a Python todo CLI with a README.',
    rootCommit: 'c1aaaaa',
    rootBranchName: 'master',
  });
  ready(master);

  const a = store.createNode({
    projectId: project.id,
    parentId: master.id,
    displayName: 'argparse',
    description: 'Build the CLI on the stdlib argparse module.',
  });
  commit(a, 'c2bbbbb', `node/${a.id}`);

  const b = store.createNode({
    projectId: project.id,
    parentId: master.id,
    displayName: 'click',
    description: 'Build the CLI on the click library instead.',
  });
  commit(b, 'c4ddddd', `node/${b.id}`);

  // Ran, answered a question, wrote nothing. No branch, no commit. Emergent.
  const e = store.createNode({
    projectId: project.id,
    parentId: a.id,
    displayName: 'why argparse?',
    description: 'How does the argument parsing handle subcommands here?',
  });
  ready(e);

  // Forks E's conversation; branches from A's commit, skipping E entirely.
  const f = store.createNode({
    projectId: project.id,
    parentId: e.id,
    displayName: 'add --verbose',
    description: 'Add a --verbose flag using the subcommand pattern discussed.',
  });
  commit(f, 'c3ccccc', `node/${f.id}`);

  return project.id;
}
