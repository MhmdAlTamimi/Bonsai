import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import {
  adoptProject,
  createChildNode,
  createProject,
  deleteNodeTree,
  deleteProjectTree,
  projectDeletionImpact,
} from '../projects.js';
import { commitRunOutput } from './commit.js';
import { branchNameFor } from './repo.js';
import { inspectDirectory } from './adopt.js';
import { git, gitLine } from './exec.js';

/**
 * Adopting a directory the user already has, against real git.
 *
 * Every test here is really the same test: Bonsai may add to the user's
 * repository and must never take anything away from it. The delete path is
 * over-represented on purpose -- it is the only code in Bonsai that can lose
 * work nobody can get back, and the bug it is guarding against was live: the
 * old branch check refused only a branch literally named "master", so deleting
 * a project adopted from a repo on `main` would have run `git branch -D main`.
 */
describe('adopting a directory', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-adopt-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A directory the user already has: a real repo, on `main`, with history. */
  async function userRepo(name = 'mine'): Promise<string> {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    await git(['init', '--initial-branch=main', '.'], path);
    await git(['config', 'user.email', 'you@example.com'], path);
    await git(['config', 'user.name', 'You'], path);
    await writeFile(join(path, 'README.md'), '# mine\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'my own first commit'], path);
    return path;
  }

  const adopt = (path: string, includeUncommitted = false) =>
    adoptProject(store, {
      path,
      description: '',
      model: null,
      permissionMode: 'default',
      includeUncommitted,
    });

  /** Stands in for the agent: writes files into a worktree, then commits. */
  async function run(nodeId: string, files: Record<string, string>): Promise<void> {
    const node = store.getNode(nodeId)!;
    const project = store.getProject(node.project_id)!;
    for (const [path, content] of Object.entries(files)) {
      const full = join(node.worktree_path, path);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    const outcome = await commitRunOutput({
      repoPath: project.repo_path,
      worktreePath: node.worktree_path,
      branchName: node.branch_name ?? branchNameFor(nodeId),
      message: 'node work',
    });
    if (outcome.committed) store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
  }

  // -- what adoption does, and does not do -----------------------------------

  test('uses the folder in place: nothing is copied or moved', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);

    const project = store.getProject(projectId)!;
    assert.equal(project.source_kind, 'adopted');
    assert.equal(project.source_path, path);
    assert.equal(project.repo_path, path);
    // Master's worktree IS the user's directory. That single fact is what makes
    // export unnecessary and deletion dangerous.
    assert.equal(store.getNode(masterNodeId)!.worktree_path, path);
    assert.equal(await readFile(join(path, 'README.md'), 'utf8'), '# mine\n');
  });

  test('leaves the branch, the history and the working tree exactly as found', async () => {
    const path = await userRepo();
    const before = await gitLine(['rev-parse', 'HEAD'], path);
    await writeFile(join(path, 'scratch.txt'), 'work in progress\n', 'utf8');

    await adopt(path);

    assert.equal(await gitLine(['branch', '--show-current'], path), 'main');
    assert.equal(await gitLine(['rev-parse', 'HEAD'], path), before);
    assert.equal(await readFile(join(path, 'scratch.txt'), 'utf8'), 'work in progress\n');
  });

  test("master takes the user's branch name, and is read-only from the start", async () => {
    const { projectId, masterNodeId } = await adopt(await userRepo());
    const master = store.treeView(projectId).find((n) => n.id === masterNodeId)!;

    assert.equal(master.displayName, 'main');
    // Not because a child committed -- there are no children. Because writing
    // here would mean Bonsai committing to the branch the user works on.
    assert.equal(master.writable, false);
    assert.equal(master.isLeaf, true);
    // The two reasons a node can be unwritable lead to different advice, so
    // they are distinguished rather than both rendering as "frozen".
    assert.equal(master.frozenReason, 'your_folder');
  });

  test("a created project's master is writable, and says nothing is frozen", async () => {
    const created = await createProject(store, {
      name: 'fresh',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const master = store
      .treeView(created.projectId)
      .find((n) => n.id === created.masterNodeId)!;
    assert.equal(master.writable, true);
    assert.equal(master.frozenReason, null);
  });

  test('a plain folder is turned into a repository, with one commit', async () => {
    const path = join(root, 'plain');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'notes.txt'), 'hello\n', 'utf8');

    const { initialised } = await adopt(path);

    assert.equal(initialised, true);
    assert.equal((await gitLine(['rev-list', '--count', 'HEAD'], path)) , '1');
    assert.equal(await readFile(join(path, 'notes.txt'), 'utf8'), 'hello\n');
  });

  test('uncommitted work can seed nodes without being committed to the branch', async () => {
    const path = await userRepo();
    const head = await gitLine(['rev-parse', 'HEAD'], path);
    await writeFile(join(path, 'draft.txt'), 'half an idea\n', 'utf8');
    await git(['add', '-A'], path); // `git stash create` ignores untracked files

    const { masterNodeId, snapshot } = await adopt(path, true);

    assert.equal(snapshot, true);
    const base = store.getNode(masterNodeId)!.head_commit!;
    assert.notEqual(base, head, 'nodes should branch from the snapshot, not from HEAD');
    // The snapshot is a commit belonging to no branch: the user's branch has
    // not moved, and their file is still sitting there uncommitted.
    assert.equal(await gitLine(['rev-parse', 'main'], path), head);
    assert.equal(await readFile(join(path, 'draft.txt'), 'utf8'), 'half an idea\n');
  });

  test('a child gets its own worktree, on a node/ branch inside the user repo', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);

    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'try something',
      description: '',
    });
    await run(nodeId, { 'feature.txt': 'new\n' });

    const child = store.getNode(nodeId)!;
    assert.equal(child.branch_name, branchNameFor(nodeId));
    assert.ok(!child.worktree_path.startsWith(path), 'the worktree lives in Bonsai\'s directory');
    // But the branch is in the user's repository, so their git can see it --
    // which is what makes an export feature unnecessary.
    const branches = await gitLine(['branch', '--format=%(refname:short)'], path);
    assert.ok(branches.split('\n').includes(child.branch_name!));
    assert.equal(await gitLine(['branch', '--show-current'], path), 'main');
  });

  // -- refusing to adopt the wrong thing -------------------------------------

  test('refuses a subdirectory of a repository, and says which folder to pick', async () => {
    const path = await userRepo();
    const inner = join(path, 'src');
    await mkdir(inner, { recursive: true });

    const inspection = await inspectDirectory(inner);
    assert.match(inspection.blockedReason ?? '', /rooted at/);
    await assert.rejects(() => adopt(inner), /rooted at/);
  });

  test('reports what it found without changing anything', async () => {
    const path = await userRepo();
    await writeFile(join(path, 'dirty.txt'), 'x\n', 'utf8');

    const inspection = await inspectDirectory(path);
    assert.equal(inspection.isGitRepo, true);
    assert.equal(inspection.branch, 'main');
    assert.equal(inspection.dirtyFiles, 1);
    assert.equal(inspection.blockedReason, null);
    assert.equal(await gitLine(['rev-list', '--count', 'HEAD'], path), '1');
  });

  // -- deletion: the part that can lose real work ----------------------------

  test('deleting the project keeps the folder, the branch and the history', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: '',
    });
    await run(nodeId, { 'feature.txt': 'new\n' });
    const head = await gitLine(['rev-parse', 'main'], path);

    const scratch = store.projectScratchDir(projectId);
    assert.ok(existsSync(scratch), 'Bonsai kept the node worktrees here');

    const result = await deleteProjectTree(store, projectId);

    assert.equal(result.keptDirectory, path);
    assert.equal(result.removedDirectory, null);
    // Their repository stays; Bonsai's own folder for the project does not.
    assert.equal(existsSync(scratch), false);
    assert.ok(existsSync(join(path, 'README.md')), "the user's files are still there");
    // The branch the user was on: still there, still where it was.
    const branches = (await gitLine(['branch', '--format=%(refname:short)'], path)).split('\n');
    assert.ok(branches.includes('main'));
    assert.equal(await gitLine(['rev-parse', 'main'], path), head);
    // Bonsai's own branch: gone, along with its worktree.
    assert.ok(!branches.includes(branchNameFor(nodeId)));
    assert.equal(existsSync(store.getNode(nodeId)?.worktree_path ?? '/nonexistent'), false);
  });

  test('deleting a node never touches the user branch it was based on', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: '',
    });
    await run(nodeId, { 'feature.txt': 'new\n' });

    await deleteNodeTree(store, nodeId);

    const branches = (await gitLine(['branch', '--format=%(refname:short)'], path)).split('\n');
    assert.ok(branches.includes('main'), 'main must survive');
    assert.ok(!branches.includes(branchNameFor(nodeId)));
    assert.ok(existsSync(join(path, 'README.md')));
  });

  test('a project on a branch called master is still the user\'s branch', async () => {
    // The regression this whole guard exists for, in its most confusing shape:
    // an adopted repo whose branch happens to share the name Bonsai gives its
    // own. The old exclusion list would not have saved it; ownership does.
    const path = join(root, 'legacy');
    await mkdir(path, { recursive: true });
    await git(['init', '--initial-branch=master', '.'], path);
    await git(['config', 'user.email', 'you@example.com'], path);
    await git(['config', 'user.name', 'You'], path);
    await writeFile(join(path, 'a.txt'), 'a\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'first'], path);

    const { projectId } = await adopt(path);
    await deleteProjectTree(store, projectId);

    const branches = (await gitLine(['branch', '--format=%(refname:short)'], path)).split('\n');
    assert.ok(branches.includes('master'));
    assert.ok(existsSync(join(path, 'a.txt')));
  });

  test('the impact reported before deleting matches what deleting does', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: '',
    });
    await run(nodeId, { 'feature.txt': 'new\n' });

    const impact = projectDeletionImpact(store, projectId)!;
    assert.equal(impact.keepsDirectory, path);
    assert.equal(impact.removesDirectory, null);
    assert.equal(impact.branches, 1);
    assert.equal(impact.nodes, 2);

    const result = await deleteProjectTree(store, projectId);
    assert.equal(result.keptDirectory, impact.keepsDirectory);
    assert.equal(result.removedDirectory, impact.removesDirectory);
  });

  // -- created projects, for contrast ----------------------------------------

  test('a created project goes in the folder you choose, and takes it with it', async () => {
    const where = join(root, 'somewhere');
    await mkdir(where, { recursive: true });

    const created = await createProject(store, {
      name: 'My Thing',
      description: '',
      model: null,
      permissionMode: 'default',
      location: where,
    });

    assert.equal(created.path, join(where, 'my-thing'));
    assert.ok(existsSync(join(where, 'my-thing', '.git')));

    const impact = projectDeletionImpact(store, created.projectId)!;
    assert.equal(impact.removesDirectory, join(where, 'my-thing'));
    assert.equal(impact.keepsDirectory, null);

    await deleteProjectTree(store, created.projectId);
    assert.equal(existsSync(join(where, 'my-thing')), false);
    // The folder the user pointed at is not the project, so it stays.
    assert.ok(existsSync(where));
  });

  test('a chosen location is never merged into an existing folder', async () => {
    // Because deleting a created project deletes this directory. Reusing a
    // folder with someone's files in it would make delete a data-loss bug that
    // no confirmation dialog could excuse.
    const where = join(root, 'busy');
    await mkdir(join(where, 'my-thing'), { recursive: true });
    await writeFile(join(where, 'my-thing', 'precious.txt'), 'do not delete\n', 'utf8');

    const created = await createProject(store, {
      name: 'My Thing',
      description: '',
      model: null,
      permissionMode: 'default',
      location: where,
    });

    assert.equal(created.path, join(where, 'my-thing-2'));
    assert.equal(await readFile(join(where, 'my-thing', 'precious.txt'), 'utf8'), 'do not delete\n');
  });

  test('a created project without a location still records where its code is', async () => {
    const created = await createProject(store, {
      name: 'default place',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const project = store.getProject(created.projectId)!;
    assert.equal(project.source_kind, 'created');
    assert.equal(project.source_path, store.getNode(created.masterNodeId)!.worktree_path);
  });
});
