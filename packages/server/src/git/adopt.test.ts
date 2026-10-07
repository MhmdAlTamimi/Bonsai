import {
  createLegacyProject as createProject,
  adoptLegacyProject as adoptProject,
} from '../testing/legacyProject.js';
import { createAllocatedChild as createChildNode } from '../testing/allocatedChild.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { workDirIn } from '../db/rows.js';
import { archiveCheck } from '../archive.js';
import { reviewOf } from '../api/review.js';
import {
  allocateNodeWorktree,
  deleteNodeTree,
  deleteProjectTree,
  projectDeletionImpact,
} from '../projects.js';
import { commitRunOutput } from './commit.js';
import { branchNameFor } from './repo.js';
import { inspectDirectory } from './adopt.js';
import { git, gitLine } from './exec.js';
import { branchOf, nodeRef } from './refs.js';
import { samePath } from '../paths.js';

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
    // As git spells it, which on Windows is not how the temp folder is spelt.
    // The test below picks a folder by another name on purpose.
    root = await realpath(await mkdtemp(join(tmpdir(), 'bonsai-adopt-')));
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
      branchName: branchOf(node),
      ref: nodeRef(node.project_id, nodeId),
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
    // Master is not their folder: it gets a checkout of its own, in Bonsai's
    // directory, the first time something needs one.
    const master = store.getNode(masterNodeId)!;
    assert.ok(!master.worktree_path.startsWith(path));
    assert.equal(master.worktree_allocated, 0);
    assert.equal(existsSync(master.worktree_path), false);
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
    // The reasons a node can be unwritable lead to different advice, so they
    // are distinguished rather than all rendering as "frozen".
    assert.equal(master.frozenReason, 'snapshot');
  });

  test('master reads the snapshot every experiment starts from, never the live folder', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);
    const adoptedAt = await gitLine(['rev-parse', 'HEAD'], path);
    // The user carries on: a commit, and an edit they have not saved.
    await writeFile(join(path, 'README.md'), '# mine, later\n', 'utf8');
    await git(['commit', '-am', 'later work'], path);
    await writeFile(join(path, 'README.md'), '# mine, unsaved\n', 'utf8');

    await allocateNodeWorktree(store, store.getNode(masterNodeId)!);
    const master = store.getNode(masterNodeId)!;
    assert.equal(await gitLine(['rev-parse', 'HEAD'], master.worktree_path), adoptedAt);
    assert.equal(await gitLine(['branch', '--show-current'], master.worktree_path), '');
    assert.equal(await readFile(join(master.worktree_path, 'README.md'), 'utf8'), '# mine\n');
    // What master's agent and Review see is that checkout: nothing changed.
    assert.equal((await reviewOf(store, master)).files.length, 0);

    // And a child starts from the same code master shows.
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: '',
    });
    const child = store.getNode(nodeId)!;
    assert.equal(child.base_commit, adoptedAt);

    // Their folder was only read: same branch, same commit, same unsaved edit.
    assert.equal(await gitLine(['branch', '--show-current'], path), 'main');
    assert.equal(await readFile(join(path, 'README.md'), 'utf8'), '# mine, unsaved\n');

    // Deleting the project removes master's checkout along with the rest.
    await deleteProjectTree(store, projectId);
    assert.equal(existsSync(master.worktree_path), false);
    assert.equal(await readFile(join(path, 'README.md'), 'utf8'), '# mine, unsaved\n');
  });

  test('a project adopted before master had a checkout keeps using the folder, read-only', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);
    // As older versions recorded it: master's folder IS theirs, on their branch.
    db.prepare(
      'UPDATE node SET worktree_path = ?, worktree_allocated = 1, branch_name = ? WHERE id = ?',
    ).run(path, 'main', masterNodeId);
    const master = store.treeView(projectId).find((n) => n.id === masterNodeId)!;
    assert.equal(master.writable, false);
    assert.equal(master.frozenReason, 'your_folder');
    assert.match(
      (await archiveCheck(store, store.getNode(masterNodeId)!, false)).blocked ?? '',
      /your own folder/,
    );

    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: '',
    });
    await run(nodeId, { 'feature.txt': 'new\n' });
    await deleteProjectTree(store, projectId);
    assert.equal(existsSync(path), true);
    assert.equal(await gitLine(['branch', '--show-current'], path), 'main');
    assert.equal(await gitLine(['for-each-ref', 'refs/bonsai/'], path), '');
  });

  test("a created project's master is writable, and says nothing is frozen", async () => {
    const created = await createProject(store, {
      name: 'fresh',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const master = store.treeView(created.projectId).find((n) => n.id === created.masterNodeId)!;
    assert.equal(master.writable, true);
    assert.equal(master.frozenReason, null);
  });

  test('a plain folder is snapshotted privately without credentials, dependencies or source changes', async () => {
    const path = join(root, 'plain');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'notes.txt'), 'hello\n', 'utf8');
    await writeFile(join(path, '.env'), 'SECRET=private\n');
    await writeFile(join(path, '.env.example'), 'SECRET=\n');
    await mkdir(join(path, 'node_modules'));
    await writeFile(join(path, 'node_modules', 'large.js'), 'dependency\n');
    await writeFile(join(path, '.gitignore'), 'scratch.txt\n');
    await writeFile(join(path, 'scratch.txt'), 'scratch\n');

    const { initialised, projectId, masterNodeId } = await adopt(path);

    assert.equal(initialised, true);
    const repo = store.getProject(projectId)!.repo_path;
    assert.equal(await gitLine(['rev-list', '--count', 'HEAD'], repo), '1');
    assert.deepEqual((await gitLine(['ls-tree', '-r', '--name-only', 'HEAD'], repo)).split('\n'), [
      '.env.example',
      '.gitignore',
      'notes.txt',
    ]);
    assert.equal(existsSync(join(path, '.git')), false);
    assert.equal(await readFile(join(path, 'notes.txt'), 'utf8'), 'hello\n');
    await allocateNodeWorktree(store, store.getNode(masterNodeId)!);
    assert.equal(
      await readFile(join(store.getNode(masterNodeId)!.worktree_path, 'notes.txt'), 'utf8'),
      'hello\n',
    );
    await deleteProjectTree(store, projectId);
    assert.equal(existsSync(repo), false);
    assert.equal(await readFile(join(path, '.env'), 'utf8'), 'SECRET=private\n');
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

  test('a child gets its own worktree, and its commits add no branch to the user repo', async () => {
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
    assert.equal(child.branch_name, nodeRef(projectId, nodeId));
    assert.ok(!child.worktree_path.startsWith(path), "the worktree lives in Bonsai's directory");
    // The commit is in the user's repository, kept by a ref that is not a
    // branch: their `git branch` (and branch pickers, and `push --all`) never
    // see it.
    assert.equal(await gitLine(['rev-parse', child.branch_name], path), child.head_commit);
    assert.equal(await gitLine(['branch', '--format=%(refname:short)'], path), 'main');
    assert.equal(await gitLine(['branch', '--show-current'], path), 'main');
  });

  // -- which version a project starts from ------------------------------------

  /** Their repo with a second branch, `feature`, one commit ahead and not checked out. */
  async function withFeatureBranch(): Promise<{ path: string; feature: string; main: string }> {
    const path = await userRepo();
    const main = await gitLine(['rev-parse', 'HEAD'], path);
    await git(['switch', '-c', 'feature'], path);
    await writeFile(join(path, 'feature.txt'), 'committed on feature\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'feature work'], path);
    const feature = await gitLine(['rev-parse', 'HEAD'], path);
    await git(['switch', 'main'], path);
    return { path, feature, main };
  }

  test('lists the branches, remote branches and tags a project can start from', async () => {
    const { path, feature, main } = await withFeatureBranch();
    await git(['tag', '-a', 'v1', '-m', 'first release', main], path);
    await git(['update-ref', 'refs/remotes/origin/fix', feature], path);
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/fix'], path);

    const points = (await inspectDirectory(path)).startPoints;
    const byName = new Map(points.map((p) => [p.name, p]));
    assert.deepEqual(byName.get('main'), {
      ref: 'refs/heads/main',
      name: 'main',
      kind: 'branch',
      commit: main,
      date: byName.get('main')!.date,
      current: true,
    });
    assert.equal(byName.get('feature')?.current, false);
    assert.equal(byName.get('feature')?.commit, feature);
    assert.equal(byName.get('origin/fix')?.kind, 'remote');
    // An annotated tag names a tag object; what it starts from is the commit.
    assert.equal(byName.get('v1')?.commit, main);
    assert.equal(byName.has('origin/HEAD'), false, 'it only names another remote branch');
    assert.ok(points.every((p) => !Number.isNaN(Date.parse(p.date))));
  });

  test('a project can start from a branch the folder is not on, and the folder stays put', async () => {
    const { path, feature } = await withFeatureBranch();
    await writeFile(join(path, 'README.md'), '# mine, unsaved\n', 'utf8');
    const { projectId, masterNodeId } = await adoptProject(store, {
      path,
      description: '',
      model: null,
      permissionMode: 'default',
      startFrom: 'refs/heads/feature',
    });

    const master = store.getNode(masterNodeId)!;
    assert.equal(master.head_commit, feature);
    assert.equal(master.display_name, 'feature');
    assert.equal(store.projectView(store.getProject(projectId)!).branchLabel, 'feature');
    await allocateNodeWorktree(store, master);
    assert.equal(
      await readFile(join(master.worktree_path, 'feature.txt'), 'utf8'),
      'committed on feature\n',
    );
    // Their folder: still on main, unsaved edit and all.
    assert.equal(await gitLine(['branch', '--show-current'], path), 'main');
    assert.equal(existsSync(join(path, 'feature.txt')), false);
    assert.equal(await readFile(join(path, 'README.md'), 'utf8'), '# mine, unsaved\n');

    // Kept even once the branch is gone and git has cleaned up.
    await git(['branch', '-D', 'feature'], path);
    await git(['reflog', 'expire', '--expire-unreachable=now', '--all'], path);
    await git(['gc', '--prune=now', '--quiet'], path);
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: '',
    });
    assert.equal(store.getNode(nodeId)!.base_commit, feature);
  });

  test('unsaved changes can only come along from the version the folder is on', async () => {
    const { path } = await withFeatureBranch();
    await writeFile(join(path, 'README.md'), '# mine, unsaved\n', 'utf8');
    await assert.rejects(
      adoptProject(store, {
        path,
        description: '',
        model: null,
        permissionMode: 'default',
        startFrom: 'refs/heads/feature',
        includeUncommitted: true,
      }),
      /unsaved changes belong to the version your folder has checked out/,
    );
    assert.equal(store.listProjects().length, 0);
    await assert.rejects(
      adoptProject(store, {
        path,
        description: '',
        model: null,
        permissionMode: 'default',
        startFrom: 'feature',
      }),
      /Choose a branch, a remote branch or a tag/,
    );
    await assert.rejects(
      adoptProject(store, {
        path,
        description: '',
        model: null,
        permissionMode: 'default',
        startFrom: 'refs/heads/gone',
      }),
      /gone is no longer in this repository/,
    );
  });

  // -- repository identity and working scope (D37) ---------------------------

  test('a folder picked by another of its names still works in its subfolder', async () => {
    const path = await userRepo();
    const inner = join(path, 'services', 'api');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'app.txt'), 'x\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'api'], path);
    // A symlink on Linux and macOS, a junction on Windows (which needs no
    // administrator). Git names the repository by its real path, so compared
    // as written the subfolder was outside it and quietly dropped: the agent
    // worked in the repository root. Windows' short names (RUNNER~1) did the
    // same without any link.
    const alias = join(root, 'alias');
    await symlink(path, alias, 'junction');
    const picked = join(alias, 'services', 'api');

    assert.equal((await inspectDirectory(picked)).workDir, 'services/api');
    const { projectId, workDir, repoPath } = await adopt(picked);
    assert.equal(workDir, 'services/api');
    assert.equal(repoPath, path);
    assert.equal(store.getProject(projectId)!.work_dir, 'services/api');
  });

  test('a folder inside a repository adopts the repository and works in the folder', async () => {
    const path = await userRepo();
    const inner = join(path, 'subproject1', 'prompts');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'one.md'), 'a prompt\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'add prompts'], path);

    const inspection = await inspectDirectory(inner);
    assert.equal(inspection.blockedReason, null);
    assert.equal(inspection.repoRoot, path);
    assert.equal(inspection.workDir, 'subproject1/prompts');
    assert.equal(
      inspection.branch,
      'main',
      'the branch is the repository\u2019s, not the folder\u2019s',
    );

    const { projectId, workDir, repoPath } = await adopt(inner);
    assert.equal(repoPath, path);
    assert.equal(workDir, 'subproject1/prompts');

    const project = store.getProject(projectId)!;
    // The repository is the identity; the subfolder is only where work happens.
    assert.equal(project.repo_path, path);
    assert.equal(project.source_path, path);
    assert.equal(project.work_dir, 'subproject1/prompts');
    assert.equal(project.protected_branch, 'main');

    const view = store.projectView(project);
    assert.equal(view.workDir, 'subproject1/prompts');
    assert.equal(view.workPath, inner);

    // No second repository was made inside the folder that was chosen.
    assert.equal(existsSync(join(inner, '.git')), false);
    // Git writes C:/… on Windows: the same folder, spelt its way.
    assert.ok(samePath(await gitLine(['rev-parse', '--show-toplevel'], inner), path));
    assert.equal(await gitLine(['branch', '--show-current'], path), 'main');
  });

  test("a child's agent works in the project's subdirectory of its own worktree", async () => {
    const path = await userRepo();
    const inner = join(path, 'services', 'api');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'server.ts'), 'export const port = 1;\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'add a service'], path);

    const { projectId, masterNodeId } = await adopt(inner);
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'change the port',
      description: '',
    });

    const node = store.getNode(nodeId)!;
    const project = store.getProject(projectId)!;
    const working = workDirIn(node.worktree_path, project.work_dir);
    assert.equal(working, join(node.worktree_path, 'services', 'api'));
    assert.ok(existsSync(working), 'the working directory exists in the new worktree');
    // The worktree is still a checkout of the WHOLE repository.
    assert.ok(existsSync(join(node.worktree_path, 'README.md')));
  });

  test('a working directory that git would not check out is still created', async () => {
    const path = await userRepo();
    // Only gitignored content, so `git worktree add` creates nothing here.
    const scratch = join(path, 'build', 'out');
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, 'artifact.bin'), 'x', 'utf8');
    await writeFile(join(path, '.gitignore'), 'build/\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'ignore build output'], path);

    const { projectId, masterNodeId } = await adopt(scratch);
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'work in the build folder',
      description: '',
    });
    const node = store.getNode(nodeId)!;
    const project = store.getProject(projectId)!;
    assert.ok(existsSync(workDirIn(node.worktree_path, project.work_dir)));
  });

  test('nested repositories resolve to the nearest enclosing one', async () => {
    const outer = await userRepo('outer');
    const inner = join(outer, 'vendor', 'library');
    await mkdir(inner, { recursive: true });
    await git(['init', '--initial-branch=trunk', '.'], inner);
    await git(['config', 'user.email', 'you@example.com'], inner);
    await git(['config', 'user.name', 'You'], inner);
    await writeFile(join(inner, 'lib.ts'), 'export const x = 1;\n', 'utf8');
    await git(['add', '-A'], inner);
    await git(['commit', '-m', 'the inner repository'], inner);

    // Standing in the inner repository, git acts on the inner repository -- so
    // Bonsai does too, rather than silently reaching past it to the outer one.
    const atInner = await inspectDirectory(inner);
    assert.equal(atInner.repoRoot, inner);
    assert.equal(atInner.workDir, '');
    assert.equal(atInner.branch, 'trunk');

    const deeper = join(inner, 'src');
    await mkdir(deeper, { recursive: true });
    const atDeeper = await inspectDirectory(deeper);
    assert.equal(atDeeper.repoRoot, inner, 'the nearest repository, not the outer one');
    assert.equal(atDeeper.workDir, 'src');

    const { projectId } = await adopt(inner);
    assert.equal(store.getProject(projectId)!.repo_path, inner);
    assert.equal(store.getProject(projectId)!.protected_branch, 'trunk');
    // The outer repository is untouched by adopting the inner one.
    assert.equal(await gitLine(['branch', '--show-current'], outer), 'main');
  });

  test('a nested plain folder gets a managed snapshot and retains its original path', async () => {
    const plain = join(root, 'plain', 'nested');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'notes.md'), 'hello\n', 'utf8');

    const inspection = await inspectDirectory(plain);
    assert.equal(inspection.repoRoot, null);
    assert.equal(inspection.blockedReason, null);

    const { projectId, workDir } = await adopt(plain);
    assert.equal(workDir, '', 'a new repository is rooted at the folder that was chosen');
    assert.notEqual(store.getProject(projectId)!.repo_path, plain);
    assert.equal(store.getProject(projectId)!.source_path, plain);
    assert.equal(existsSync(join(plain, '.git')), false);
  });

  // -- refusing to adopt the wrong thing -------------------------------------

  test('home and filesystem root are refused before adoption', async () => {
    for (const path of [homedir(), parse(root).root]) {
      assert.match((await inspectDirectory(path)).blockedReason ?? '', /home folder|whole disk/);
      await assert.rejects(adopt(path), /home folder|whole disk/);
    }
    assert.equal(store.listProjects().length, 0);
  });

  test('recognises its own folders from the database, not from git', async () => {
    const path = await userRepo();
    const { projectId, masterNodeId } = await adopt(path);
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'try Redis',
      description: '',
    });

    // A node's worktree names the node. This is the case that used to produce
    // a sentence about linked git worktrees and advice leading to a bare repo.
    const child = store.getNode(nodeId)!;
    const found = store.findFolderOwner(child.worktree_path);
    assert.equal(found?.node?.id, nodeId);
    assert.equal(found?.project.id, projectId);

    // The adopted folder itself belongs to the project and to no node: master
    // has a checkout of its own, which names master.
    assert.equal(store.findFolderOwner(path)?.project.id, projectId);
    assert.equal(store.findFolderOwner(path)?.node, null);
    const master = store.getNode(masterNodeId)!;
    assert.equal(store.findFolderOwner(master.worktree_path)?.node?.id, masterNodeId);

    // Scaffolding around the worktrees belongs to the project but to no node.
    const scratch = store.projectScratchDir(projectId);
    assert.equal(store.findFolderOwner(join(scratch, 'worktrees'))?.project.id, projectId);
    assert.equal(store.findFolderOwner(join(scratch, 'worktrees'))?.node, null);

    // Somewhere unrelated is nobody's.
    assert.equal(store.findFolderOwner(join(root, 'elsewhere')), null);
  });

  test("a created project's bare repository is recognised too", async () => {
    const created = await createProject(store, {
      name: 'owned',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const project = store.getProject(created.projectId)!;
    // `git rev-parse --show-toplevel` fails inside a bare repo, so without this
    // lookup the picker would treat it as a plain folder and offer to git-init
    // Bonsai's own repository.
    assert.equal(store.findFolderOwner(project.repo_path)?.project.id, created.projectId);
  });

  test('a folder next to an adopted project is not claimed by it', async () => {
    // Containment only covers directories Bonsai created. An adopted project's
    // folder is the user's, and its neighbours are none of Bonsai's business.
    const path = await userRepo();
    await adopt(path);
    const sibling = join(root, 'unrelated');
    await mkdir(sibling, { recursive: true });
    assert.equal(store.findFolderOwner(sibling), null);
  });

  test('an unrelated linked worktree is refused in plain language', async () => {
    // Still a real case: a second checkout of a repository that has nothing to
    // do with Bonsai. The message must name a folder the user can actually
    // pick, which the old one did not -- it stripped "/.git" with a hard-coded
    // forward slash and named the git directory.
    const path = await userRepo();
    const second = join(root, 'second-checkout');
    await git(['worktree', 'add', '--detach', second], path);

    const inspection = await inspectDirectory(second);
    assert.equal(
      inspection.blockedReason,
      `This folder is a second checkout of a repository that lives at ${path}. Pick that repository's main folder instead.`,
    );
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

  test('projects sharing a repository retain separate work when either is deleted', async () => {
    const path = await userRepo();
    const first = await adopt(path);
    const second = await adopt(path);
    const child = await createChildNode(store, {
      projectId: second.projectId,
      parentId: second.masterNodeId,
      displayName: 'keep',
      description: '',
    });
    await run(child.nodeId, { 'keep.txt': 'keep me\n' });
    const survivor = store.getNode(child.nodeId)!;
    await deleteProjectTree(store, first.projectId);
    assert.ok(store.getProject(second.projectId));
    assert.equal(await readFile(join(survivor.worktree_path, 'keep.txt'), 'utf8'), 'keep me\n');
    assert.equal(await gitLine(['rev-parse', survivor.branch_name!], path), survivor.head_commit);
    await deleteProjectTree(store, second.projectId);
    assert.ok(existsSync(join(path, 'README.md')));
  });

  test('created projects own distinct generated storage and deleting one preserves the other', async () => {
    const options = {
      name: 'same name',
      description: '',
      model: null,
      permissionMode: 'default' as const,
    };
    const a = await createProject(store, options);
    const b = await createProject(store, options);
    const kept = store.getNode(b.masterNodeId)!;
    assert.notEqual(store.projectScratchDir(a.projectId), store.projectScratchDir(b.projectId));
    await deleteProjectTree(store, a.projectId);
    assert.ok(existsSync(kept.worktree_path));
    assert.equal(await gitLine(['rev-parse', 'HEAD'], kept.worktree_path), kept.head_commit);
  });

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

  test("a project on a branch called master is still the user's branch", async () => {
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
    // And one as older versions of Bonsai left it: on a `node/<uuid>` branch.
    const older = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'older',
      description: '',
    });
    await run(older.nodeId, { 'older.txt': 'old\n' });
    const olderPath = store.getNode(older.nodeId)!.worktree_path;
    await git(['switch', '-c', branchNameFor(older.nodeId)], olderPath);
    db.prepare('UPDATE node SET branch_name = ? WHERE id = ?').run(
      branchNameFor(older.nodeId),
      older.nodeId,
    );

    const impact = projectDeletionImpact(store, projectId)!;
    assert.equal(impact.keepsDirectory, path);
    assert.equal(impact.removesDirectory, null);
    assert.equal(impact.branches, 1, 'only the older experiment has one');
    assert.equal(impact.nodes, 3);

    const result = await deleteProjectTree(store, projectId);
    assert.equal(result.keptDirectory, impact.keepsDirectory);
    assert.equal(result.removedDirectory, impact.removesDirectory);
    assert.equal(await gitLine(['branch', '--format=%(refname:short)'], path), 'main');
    assert.equal(await gitLine(['for-each-ref', 'refs/bonsai/'], path), '');
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
    assert.equal(
      await readFile(join(where, 'my-thing', 'precious.txt'), 'utf8'),
      'do not delete\n',
    );
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
