import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { adoptProject, createChildNode, createProject } from '../projects.js';
import { commitRunOutput } from '../git/commit.js';
import { branchNameFor } from '../git/repo.js';
import { git, gitLine } from '../git/exec.js';
import { checkoutFor } from './checkout.js';
import { runCommand } from '../exec/command.js';

/**
 * The command that gets a node's work into a terminal.
 *
 * Every test here RUNS the command it is given, which is the only kind of
 * assertion worth making about a string that exists to be pasted into a shell.
 * The first version of this feature produced `git switch node/<uuid>` for an
 * adopted project, which reads correctly and fails every time: the branch is
 * checked out in Bonsai's own worktree and git will not check one out twice.
 * Comparing it to an expected string would have passed.
 */
describe('the checkout command', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-checkout-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Creates a child, commits something in it, and returns the node. */
  async function nodeWithWork(projectId: string, parentId: string, name: string) {
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId,
      displayName: name,
      description: '',
    });
    const node = store.getNode(nodeId)!;
    await writeFile(join(node.worktree_path, 'result.txt'), 'the winning approach\n', 'utf8');
    const outcome = await commitRunOutput({
      repoPath: store.getProject(projectId)!.repo_path,
      worktreePath: node.worktree_path,
      branchName: branchNameFor(nodeId),
      message: 'work',
      baseCommit: node.base_commit,
    });
    store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
    return store.getNode(nodeId)!;
  }

  test("an adopted project's command runs in the user's own folder", async () => {
    const folder = join(root, 'mine');
    await git(['init', '--initial-branch=main', folder], root);
    await git(['config', 'user.email', 'a@b.c'], folder);
    await git(['config', 'user.name', 'A'], folder);
    await writeFile(join(folder, 'README.md'), '# mine\n', 'utf8');
    await git(['add', '-A'], folder);
    await git(['commit', '-m', 'first'], folder);

    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const node = await nodeWithWork(adopted.projectId, adopted.masterNodeId, 'try Redis');
    const checkout = checkoutFor(store.getProject(adopted.projectId), node)!;

    assert.ok(checkout.command.includes(node.branch_name!));
    assert.match(checkout.hint, /your own branch/);

    // The part that matters: it works, in their folder, while Bonsai's
    // worktree still holds the same branch.
    const result = await runCommand({ command: checkout.command, cwd: folder, timeoutMs: 30_000 });
    assert.equal(result.ok, true, `${checkout.command}\n${result.stderr}`);
    assert.equal(await gitLine(['branch', '--show-current'], folder), 'try-redis');
    assert.match(
      await gitLine(['show', '--name-only', '--format=', 'HEAD'], folder),
      /result\.txt/,
    );
    // And their own branch is untouched.
    assert.notEqual(
      await gitLine(['rev-parse', 'main'], folder),
      await gitLine(['rev-parse', 'HEAD'], folder),
    );
  });

  test("a created project's command clones out of Bonsai's own repository", async () => {
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    // A name with characters a branch and a folder cannot both take.
    const node = await nodeWithWork(created.projectId, created.masterNodeId, 'a node/with slashes');
    const checkout = checkoutFor(store.getProject(created.projectId), node)!;

    // `git switch` cannot run in a bare repository, so the command has to name
    // the location and clone out of it.
    assert.match(checkout.command, /^git clone /);

    const into = join(root, 'elsewhere');
    await git(['init', into], root); // just to create the directory
    await rm(join(into, '.git'), { recursive: true, force: true });
    const result = await runCommand({ command: checkout.command, cwd: into, timeoutMs: 60_000 });
    assert.equal(result.ok, true, `${checkout.command}\n${result.stderr}`);
    assert.match(
      await gitLine(
        ['show', '--name-only', '--format=', 'HEAD'],
        join(into, 'a-node-with-slashes'),
      ),
      /result\.txt/,
    );
  });

  test('a node with no commits has no command', async () => {
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: created.projectId,
      parentId: created.masterNodeId,
      displayName: 'just a question',
      description: '',
    });
    // No branch exists until a run commits, which is the emergent model --
    // offering a command for a ref that does not exist would be a lie.
    assert.equal(checkoutFor(store.getProject(created.projectId), store.getNode(nodeId)!), null);
  });

  test('a path with a space survives being pasted into a shell', async () => {
    const store2 = new Store(openInMemory(), join(root, 'repos with a space'));
    const created = await createProject(store2, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store2, {
      projectId: created.projectId,
      parentId: created.masterNodeId,
      displayName: 'child',
      description: '',
    });
    const node = store2.getNode(nodeId)!;
    await writeFile(join(node.worktree_path, 'x.txt'), 'x\n', 'utf8');
    const outcome = await commitRunOutput({
      repoPath: store2.getProject(created.projectId)!.repo_path,
      worktreePath: node.worktree_path,
      branchName: branchNameFor(nodeId),
      message: 'w',
      baseCommit: node.base_commit,
    });
    store2.recordCommit(nodeId, outcome.branch!, outcome.commit!);

    const checkout = checkoutFor(store2.getProject(created.projectId), store2.getNode(nodeId)!)!;
    assert.ok(checkout.command.includes("'"), 'the path should be quoted');
    const result = await runCommand({ command: checkout.command, cwd: root, timeoutMs: 60_000 });
    assert.equal(result.ok, true, `${checkout.command}\n${result.stderr}`);
  });
});
