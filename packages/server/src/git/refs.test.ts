import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { archiveCheck, archiveFolder } from '../archive.js';
import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { silentLogger } from '../log.js';
import {
  adoptProject,
  allocateNodeWorktree,
  createChildNode,
  createProject,
  deleteNodeTree,
  deleteProjectTree,
  pinExistingNodes,
} from '../projects.js';
import { createAllocatedChild } from '../testing/allocatedChild.js';
import { commitRunOutput } from './commit.js';
import { git, gitLine } from './exec.js';
import { branchOf, nodeRef, readRef } from './refs.js';
import { commitExists } from './repo.js';

/**
 * Hidden refs against real git: what they keep, and what they refuse.
 *
 * The cleanup here is git's own, made immediate: `reflog expire` and
 * `gc --prune=now` do at once what `gc --auto` does to an unreachable commit
 * weeks later. A commit that survives them is one git will not remove.
 */
describe('hidden refs', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-refs-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A folder of the user's with history, on `main`, and optionally an unsaved edit. */
  async function userRepo(unsaved: string | null = null): Promise<string> {
    const path = join(root, 'mine');
    await mkdir(path, { recursive: true });
    await git(['init', '--initial-branch=main', '.'], path);
    await writeFile(join(path, 'README.md'), '# mine\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'my own first commit'], path);
    if (unsaved !== null) await writeFile(join(path, 'README.md'), unsaved, 'utf8');
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

  const created = () =>
    createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });

  const child = (projectId: string, parentId: string) =>
    createAllocatedChild(store, { projectId, parentId, displayName: 'child', description: '' });

  /** Everything git would remove on its own, removed now. */
  async function cleanUp(repo: string): Promise<void> {
    await git(['reflog', 'expire', '--expire-unreachable=now', '--all'], repo);
    await git(['gc', '--prune=now', '--quiet'], repo);
  }

  /** Stands in for a run: writes files, commits, records. */
  async function run(nodeId: string, files: Record<string, string>): Promise<string> {
    const node = store.getNode(nodeId)!;
    for (const [path, content] of Object.entries(files))
      await writeFile(join(node.worktree_path, path), content, 'utf8');
    const outcome = await commitRunOutput({
      repoPath: store.getProject(node.project_id)!.repo_path,
      worktreePath: node.worktree_path,
      branchName: branchOf(node),
      ref: nodeRef(node.project_id, nodeId),
      message: 'work',
    });
    store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
    return outcome.commit!;
  }

  test('an adopted snapshot of unsaved work outlives git’s cleanup, and experiments still start from it', async () => {
    const path = await userRepo('# mine, edited\n');
    const project = await adopt(path, true);
    const snapshot = store.getNode(project.masterNodeId)!.head_commit!;
    // On none of their branches, and no folder is checked out at it: before
    // refs, nothing at all kept it.
    assert.equal(await gitLine(['branch', '--contains', snapshot], path), '');
    assert.equal(await readRef(path, nodeRef(project.projectId, project.masterNodeId)), snapshot);

    await cleanUp(path);
    assert.equal(await commitExists(path, snapshot), true);

    const { nodeId } = await child(project.projectId, project.masterNodeId);
    const node = store.getNode(nodeId)!;
    assert.equal(node.base_commit, snapshot);
    assert.equal(await readFile(join(node.worktree_path, 'README.md'), 'utf8'), '# mine, edited\n');
  });

  test('an archived experiment that never committed keeps its starting code', async () => {
    const path = await userRepo('# mine, edited\n');
    const project = await adopt(path, true);
    const { nodeId } = await child(project.projectId, project.masterNodeId);
    await archiveFolder(store, store.getNode(nodeId)!, false);
    assert.equal(existsSync(store.getNode(nodeId)!.worktree_path), false);

    await cleanUp(path);
    await allocateNodeWorktree(store, store.getNode(nodeId)!);
    const restored = store.getNode(nodeId)!;
    assert.equal(
      await gitLine(['rev-parse', 'HEAD'], restored.worktree_path),
      restored.base_commit,
    );
  });

  test('experiments add no branches, and `git push --all` sends none of their work', async () => {
    const path = await userRepo();
    const project = await adopt(path);
    const { nodeId } = await child(project.projectId, project.masterNodeId);
    const commit = await run(nodeId, { 'idea.txt': 'an experiment\n' });

    assert.equal(await gitLine(['branch', '--format=%(refname:short)'], path), 'main');
    const remote = join(root, 'remote.git');
    await git(['init', '--bare', '--initial-branch=main', remote], root);
    await git(['push', '--all', remote], path);
    assert.equal(await gitLine(['for-each-ref', '--format=%(refname)'], remote), 'refs/heads/main');
    assert.equal(await commitExists(remote, commit), false);
  });

  test('a node’s ref follows each commit it makes', async () => {
    const project = await created();
    const { nodeId, baseCommit } = await child(project.projectId, project.masterNodeId);
    const ref = nodeRef(project.projectId, nodeId);
    const repo = store.getProject(project.projectId)!.repo_path;
    assert.equal(await readRef(repo, ref), baseCommit, 'from creation, at its base');

    const first = await run(nodeId, { 'a.txt': 'one\n' });
    assert.equal(await readRef(repo, ref), first);
    const second = await run(nodeId, { 'a.txt': 'two\n' });
    assert.equal(await readRef(repo, ref), second);
    // Master's moves with master's commits, in its own ref.
    const master = await run(project.masterNodeId, { 'm.txt': 'm\n' });
    assert.equal(await readRef(repo, nodeRef(project.projectId, project.masterNodeId)), master);
  });

  test('a ref moved outside Bonsai stops the commit before anything is written', async () => {
    const project = await created();
    const rootCommit = store.getNode(project.masterNodeId)!.head_commit!;
    await run(project.masterNodeId, { 'm.txt': 'm\n' });
    const { nodeId, baseCommit } = await child(project.projectId, project.masterNodeId);
    const repo = store.getProject(project.projectId)!.repo_path;
    // Back to master's first commit: not where this node's code is.
    await git(['update-ref', nodeRef(project.projectId, nodeId), rootCommit], repo);

    const node = store.getNode(nodeId)!;
    await assert.rejects(run(nodeId, { 'work.txt': 'kept\n' }), /moved outside Bonsai/);
    assert.equal(await gitLine(['rev-parse', 'HEAD'], node.worktree_path), baseCommit);
    assert.equal(await readFile(join(node.worktree_path, 'work.txt'), 'utf8'), 'kept\n');
    assert.equal(await readRef(repo, nodeRef(project.projectId, nodeId)), rootCommit);
  });

  test('nothing can start from code git no longer has, and nothing is made trying', async () => {
    const project = await created();
    db.prepare('UPDATE node SET head_commit = ? WHERE id = ?').run(
      'e'.repeat(40),
      project.masterNodeId,
    );
    await assert.rejects(
      createChildNode(store, {
        projectId: project.projectId,
        parentId: project.masterNodeId,
        displayName: 'child',
        description: '',
      }),
      /commit eeeeeee\) is no longer in the repository/,
    );
    assert.equal(store.listNodes(project.projectId).length, 1);
  });

  test('archiving refuses a folder whose git state changed outside Bonsai', async () => {
    const project = await created();
    const { nodeId } = await child(project.projectId, project.masterNodeId);
    const node = store.getNode(nodeId)!;
    // Committed by hand: on a detached checkout only the folder keeps it.
    await writeFile(join(node.worktree_path, 'mine.txt'), 'by hand\n', 'utf8');
    await git(['add', '-A'], node.worktree_path);
    await git(['commit', '-m', 'by hand'], node.worktree_path);

    assert.match((await archiveCheck(store, node, false)).blocked ?? '', /changed outside Bonsai/);
    await assert.rejects(archiveFolder(store, node, false), /changed outside Bonsai/);
    assert.equal(existsSync(node.worktree_path), true);
  });

  test('deleting removes Bonsai’s own refs and nothing of anyone else’s', async () => {
    const path = await userRepo();
    const project = await adopt(path);
    const { nodeId } = await child(project.projectId, project.masterNodeId);
    const head = await gitLine(['rev-parse', 'HEAD'], path);
    // Someone else's refs in the same repository, one of them looking a lot like ours.
    await git(['update-ref', 'refs/bonsai/another-project/x', head], path);
    await git(['update-ref', 'refs/heads/feature', head], path);

    await deleteNodeTree(store, nodeId);
    assert.equal(await readRef(path, nodeRef(project.projectId, nodeId)), null);
    assert.equal(await readRef(path, nodeRef(project.projectId, project.masterNodeId)), head);

    await deleteProjectTree(store, project.projectId);
    assert.equal(await gitLine(['for-each-ref', `refs/bonsai/${project.projectId}/`], path), '');
    assert.equal(await readRef(path, 'refs/bonsai/another-project/x'), head);
    assert.equal(await readRef(path, 'refs/heads/feature'), head);
  });

  test('deletion refuses a ref that moved outside Bonsai', async () => {
    const project = await created();
    const master = await run(project.masterNodeId, { 'm.txt': 'm\n' });
    const { nodeId } = await child(project.projectId, project.masterNodeId);
    const repo = store.getProject(project.projectId)!.repo_path;
    const ref = nodeRef(project.projectId, nodeId);
    await run(nodeId, { 'c.txt': 'c\n' });
    await git(['update-ref', ref, master], repo);

    await assert.rejects(deleteNodeTree(store, nodeId), /changed outside Bonsai/);
    assert.ok(store.getNode(nodeId));
    assert.equal(await readRef(repo, ref), master);
  });

  test('startup gives older nodes their refs, and leaves a moved one where it is', async () => {
    const project = await created();
    const { nodeId, baseCommit } = await child(project.projectId, project.masterNodeId);
    const repo = store.getProject(project.projectId)!.repo_path;
    const masterRef = nodeRef(project.projectId, project.masterNodeId);
    const rootCommit = store.getNode(project.masterNodeId)!.head_commit!;
    const later = await run(project.masterNodeId, { 'm.txt': 'm\n' });
    // A node from before refs existed, and one whose ref someone moved back.
    await git(['update-ref', '-d', nodeRef(project.projectId, nodeId)], repo);
    await git(['update-ref', masterRef, rootCommit], repo);

    assert.equal(await pinExistingNodes(store, silentLogger), 1);
    assert.equal(await readRef(repo, nodeRef(project.projectId, nodeId)), baseCommit);
    assert.equal(await readRef(repo, masterRef), rootCommit, 'drift is reported, never repaired');
    assert.notEqual(later, rootCommit);
    assert.equal(await pinExistingNodes(store, silentLogger), 0, 'and once is enough');
  });
});
