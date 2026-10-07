import { createLegacyProject as createProject } from './testing/legacyProject.js';
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './db/open.js';
import { Store } from './db/store.js';
import {
  createChildNode,
  cancelPendingDeletion,
  deleteNodeTree,
  deleteProjectTree,
  recoverDeletions,
} from './projects.js';
import { createAllocatedChild } from './testing/allocatedChild.js';
import { RunJobs } from './jobs/runNode.js';
import { FakeRunner } from './agent/FakeRunner.js';
import { EventBus } from './api/events.js';
import { silentLogger } from './log.js';
import { git, gitLine } from './git/exec.js';
import { nodeRef, readRef } from './git/refs.js';
import { addDetachedWorktree } from './git/worktree.js';
import { gitRecovery, synchronizeExperiment } from './git/reconcile.js';

let dir: string;
let db: ReturnType<typeof openDatabase>;
let store: Store;
let projectId: string;
let masterNodeId: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bonsai-delete-recovery-'));
  db = openDatabase(dir);
  store = new Store(db, join(dir, 'repos'));
  ({ projectId, masterNodeId } = await createProject(store, {
    name: 'delete fixture',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  }));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});
const reopen = () => {
  db.close();
  db = openDatabase(dir);
  store = new Store(db, join(dir, 'repos'));
};
const child = () =>
  createAllocatedChild(store, {
    projectId,
    parentId: masterNodeId,
    displayName: 'child',
    description: '',
  });

test('a Git failure after removing a folder leaves a durable deletion that restart completes', async () => {
  const { nodeId } = await child();
  const node = store.getNode(nodeId)!;
  const repo = store.getProject(projectId)!.repo_path;
  await git(['pack-refs', '--all'], repo);
  await writeFile(join(repo, 'packed-refs.lock'), 'fixture lock');
  await assert.rejects(deleteNodeTree(store, nodeId), /packed-refs.lock/);
  assert.equal(
    existsSync(node.worktree_path),
    false,
    'the failure really occurs after filesystem removal',
  );
  assert.ok(store.getNode(nodeId));
  assert.ok(store.treeView(projectId).find((view) => view.id === nodeId)?.deletion);
  const jobs = new RunJobs(store, new EventBus(), new FakeRunner());
  assert.throws(() => jobs.start(nodeId, 'cannot run'), /pending deletion/);
  await assert.rejects(
    createChildNode(store, {
      projectId,
      parentId: nodeId,
      displayName: 'blocked',
      description: '',
    }),
    /pending deletion/,
  );
  reopen();
  await rm(join(repo, 'packed-refs.lock'));
  assert.equal(await recoverDeletions(store, silentLogger), 1);
  assert.equal(store.getNode(nodeId), undefined);
  assert.equal(await readRef(repo, nodeRef(projectId, nodeId)), null);
  assert.equal(store.deletions.pending().length, 0);
  assert.equal(await recoverDeletions(store, silentLogger), 0);
});

test('remaining deletion can be cancelled while saved objects exist, and missing files are explicitly recoverable', async () => {
  const { nodeId } = await child();
  const node = store.getNode(nodeId)!;
  const repo = store.getProject(projectId)!.repo_path;
  await git(['pack-refs', '--all'], repo);
  await writeFile(join(repo, 'packed-refs.lock'), 'fixture lock');
  await assert.rejects(deleteNodeTree(store, nodeId));
  await rm(join(repo, 'packed-refs.lock'));
  await cancelPendingDeletion(store, `node:${nodeId}`);
  assert.equal(store.deletions.pending().length, 0);
  const recovery = (await gitRecovery(store, store.getNode(nodeId)!))!;
  assert.equal(recovery.problem, 'missing_folder');
  await synchronizeExperiment(store, store.getNode(nodeId)!, 'restore', recovery.version);
  assert.equal(await gitLine(['rev-parse', 'HEAD'], node.worktree_path), node.base_commit);
});

test('deletion recovery refuses a later changed ref and preserves its work', async () => {
  const { nodeId } = await child();
  const node = store.getNode(nodeId)!;
  const repo = store.getProject(projectId)!.repo_path;
  await git(['pack-refs', '--all'], repo);
  await writeFile(join(repo, 'packed-refs.lock'), 'fixture lock');
  await assert.rejects(deleteNodeTree(store, nodeId));
  await rm(join(repo, 'packed-refs.lock'));
  const newCommit = await gitLine(
    [
      'commit-tree',
      await gitLine(['rev-parse', `${node.base_commit}^{tree}`], repo),
      '-p',
      node.base_commit!,
      '-m',
      'external',
    ],
    repo,
  );
  await git(['update-ref', nodeRef(projectId, nodeId), newCommit], repo);
  reopen();
  assert.equal(await recoverDeletions(store, silentLogger), 0);
  assert.equal(await readRef(repo, nodeRef(projectId, nodeId)), newCommit);
  assert.ok(store.getNode(nodeId));
  assert.match(store.deletions.get(`node:${nodeId}`)!.error!, /changed outside Bonsai/);
});

test('a project row deletion failure after filesystem cleanup resumes without its repository', async () => {
  db.exec(
    "CREATE TRIGGER block_project_delete BEFORE DELETE ON project BEGIN SELECT RAISE(ABORT, 'fixture DB failure'); END",
  );
  const repo = store.getProject(projectId)!.repo_path;
  await assert.rejects(deleteProjectTree(store, projectId), /fixture DB failure/);
  assert.equal(existsSync(repo), false);
  assert.ok(store.getProject(projectId));
  reopen();
  db.exec('DROP TRIGGER block_project_delete');
  assert.equal(await recoverDeletions(store, silentLogger), 1);
  assert.equal(store.getProject(projectId), undefined);
  assert.equal(store.deletions.pending().length, 0);
});

test('an unallocated experiment cannot delete an unexpected matching checkout', async () => {
  const { nodeId } = await createChildNode(store, {
    projectId,
    parentId: masterNodeId,
    displayName: 'unallocated',
    description: '',
  });
  const node = store.getNode(nodeId)!;
  await addDetachedWorktree(
    store.getProject(projectId)!.repo_path,
    node.worktree_path,
    node.base_commit!,
  );
  await writeFile(join(node.worktree_path, 'keep.txt'), 'unexpected work');
  await assert.rejects(deleteNodeTree(store, nodeId), /unexpected folder/);
  assert.equal(await readFile(join(node.worktree_path, 'keep.txt'), 'utf8'), 'unexpected work');
  const recovery = (await gitRecovery(store, node))!;
  assert.equal(recovery.canImportFolder, true);
  const preserved = await synchronizeExperiment(store, node, 'import-folder', recovery.version);
  await deleteProjectTree(store, projectId);
  assert.equal(
    await readFile(join(preserved, 'keep.txt'), 'utf8'),
    'unexpected work',
    'recovery copies must outlive project deletion',
  );
  await git(['fsck', '--no-dangling'], preserved);
});

test('a locked checkout blocks the whole initial delete before any folder is removed', async () => {
  const a = await child();
  const b = await child();
  const parent = store.getNode(masterNodeId)!;
  const locked = store.getNode(b.nodeId)!;
  const repo = store.getProject(projectId)!.repo_path;
  await git(['worktree', 'lock', '--reason', 'user lock', locked.worktree_path], repo);
  await assert.rejects(deleteProjectTree(store, projectId), /locked by Git/);
  assert.equal(existsSync(parent.worktree_path), true);
  assert.equal(existsSync(store.getNode(a.nodeId)!.worktree_path), true);
  assert.equal(existsSync(locked.worktree_path), true);
  assert.equal(store.deletions.pending().length, 0);
  await git(['worktree', 'unlock', locked.worktree_path], repo);
  await deleteProjectTree(store, projectId);
  assert.equal(store.getProject(projectId), undefined);
});
