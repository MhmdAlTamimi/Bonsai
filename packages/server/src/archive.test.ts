import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { ArchiveSweeper, archiveCheck, archiveFolder, isRebuilt, storageUse } from './archive.js';
import { reviewOf } from './api/review.js';
import { EventBus } from './api/events.js';
import { openInMemory } from './db/open.js';
import { Store } from './db/store.js';
import { commitMessageFor, commitRunOutput } from './git/commit.js';
import { gitLine } from './git/exec.js';
import { expectedGitState, readGitState } from './git/ownership.js';
import { branchExists, branchNameFor } from './git/repo.js';
import { silentLogger } from './log.js';
import { allocateNodeWorktree, createProject, deleteNodeTree } from './projects.js';
import { createAllocatedChild } from './testing/allocatedChild.js';

const DAY = 24 * 60 * 60 * 1000;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('archiving an experiment’s folder', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-archive-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });
  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  async function write(nodeId: string, files: Record<string, string>): Promise<void> {
    const node = store.getNode(nodeId)!;
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(node.worktree_path, path)), { recursive: true });
      await writeFile(join(node.worktree_path, path), content, 'utf8');
    }
  }

  /** A run that writes files and commits, the way the pipeline records one. */
  async function run(nodeId: string, files: Record<string, string>): Promise<void> {
    await write(nodeId, files);
    const node = store.getNode(nodeId)!;
    const project = store.getProject(node.project_id)!;
    const outcome = await commitRunOutput({
      repoPath: project.repo_path,
      worktreePath: node.worktree_path,
      branchName: node.branch_name ?? branchNameFor(nodeId),
      message: commitMessageFor(node.display_name, node.description),
      baseCommit: node.base_commit,
    });
    const runId = `run-${Math.random()}`;
    store.createRun(runId, nodeId);
    if (outcome.committed) store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
    store.finishRun(
      runId,
      { status: 'done', reason: 'finished', error: null },
      { cost: 0, inputTokens: 0, outputTokens: 0, commitSha: outcome.commit },
    );
  }

  async function experiment(): Promise<{ projectId: string; childId: string }> {
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    await run(masterNodeId, {
      'app.py': 'print(1)\n',
      '.gitignore': 'node_modules/\nsecret.db\n',
    });
    const child = await createAllocatedChild(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'try',
      description: '',
    });
    return { projectId, childId: child.nodeId };
  }

  test('dependencies and build output are rebuilt; anything else ignored is not', () => {
    for (const path of [
      'node_modules/',
      'packages/ui/node_modules/',
      'dist/',
      '.venv/',
      'src/__pycache__/',
      'app.egg-info/',
      'debug.log',
      '.DS_Store',
    ])
      assert.equal(isRebuilt(path, []), true, path);
    for (const path of ['secret.db', '.env', 'data/'])
      assert.equal(isRebuilt(path, []), false, path);
    // Copy-in files come back from the project's folder when the folder does.
    assert.equal(isRebuilt('.env', ['.env']), true);
  });

  test('removes the folder, keeps the branch, and brings it back at the same path', async () => {
    const { childId } = await experiment();
    await run(childId, { 'app.py': 'print(2)\n' });
    store.markSetupRan(childId);
    await write(childId, { 'node_modules/left-pad/index.js': 'x' });
    const before = store.getNode(childId)!;
    const project = store.getProject(before.project_id)!;

    assert.deepEqual(await archiveCheck(store, before, false), { blocked: null, ignored: [] });
    await archiveFolder(store, before, false);

    const archived = store.getNode(childId)!;
    assert.equal(await exists(before.worktree_path), false);
    assert.equal(archived.worktree_allocated, 0);
    assert.notEqual(archived.archived_at, null);
    assert.equal(archived.setup_ran_at, null, 'setup runs again in the new folder');
    assert.equal(
      store.treeView(archived.project_id).find((n) => n.id === childId)!.folder,
      'archived',
    );
    // The branch and its commit are still there.
    assert.equal(
      await gitLine(['rev-parse', `refs/heads/${archived.branch_name}`], project.repo_path),
      archived.head_commit,
    );
    // Review reads the commits from the repository.
    const review = await reviewOf(store, archived);
    assert.deepEqual(
      review.files.map((f) => [f.path, f.status]),
      [['app.py', 'M']],
    );

    await allocateNodeWorktree(store, archived);
    const restored = store.getNode(childId)!;
    assert.equal(restored.worktree_path, before.worktree_path);
    assert.equal(restored.worktree_allocated, 1);
    assert.equal(restored.archived_at, null);
    assert.notEqual(restored.restored_at, null);
    // On its branch, at its last commit: exactly what the next run checks for.
    assert.deepEqual(
      await readGitState(restored.worktree_path),
      await expectedGitState(project.repo_path, restored),
    );
  });

  test('an experiment that committed nothing comes back where it started', async () => {
    const { childId } = await experiment();
    const node = store.getNode(childId)!;
    await archiveFolder(store, node, false);
    await allocateNodeWorktree(store, store.getNode(childId)!);
    const project = store.getProject(node.project_id)!;
    assert.deepEqual(
      await readGitState(node.worktree_path),
      await expectedGitState(project.repo_path, store.getNode(childId)!),
    );
  });

  test('never while running, with uncommitted work, or before the folder exists', async () => {
    const { childId } = await experiment();
    const node = store.getNode(childId)!;
    assert.match((await archiveCheck(store, node, true)).blocked ?? '', /running/);
    await write(childId, { 'app.py': 'half done\n' });
    assert.match((await archiveCheck(store, node, false)).blocked ?? '', /1 file/);
    await assert.rejects(archiveFolder(store, node, false), /Resume or discard/);
    assert.equal(await exists(node.worktree_path), true);
  });

  test('asks before deleting ignored files the next run cannot bring back', async () => {
    const { childId } = await experiment();
    await write(childId, { 'secret.db': 'rows', 'node_modules/x.js': 'x' });
    const node = store.getNode(childId)!;
    assert.deepEqual(await archiveCheck(store, node, false), {
      blocked: null,
      ignored: ['secret.db'],
    });
    await assert.rejects(archiveFolder(store, node, false), /secret\.db/);
    assert.equal(await exists(node.worktree_path), true);
    await archiveFolder(store, node, true);
    assert.equal(await exists(node.worktree_path), false);
  });

  test('the idle sweep archives what is safe and old enough, and nothing else', async () => {
    const { projectId, childId } = await experiment();
    const other = await createAllocatedChild(store, {
      projectId,
      parentId: store.getNode(childId)!.parent_id!,
      displayName: 'keeps a database',
      description: '',
    });
    await write(other.nodeId, { 'secret.db': 'rows' });
    const sweeper = new ArchiveSweeper({
      store,
      bus: new EventBus(),
      log: silentLogger,
      jobs: { isRunning: () => false, whileIdle: (_id, work) => work() },
      settings: { archiveAfterDays: () => 3 },
    });

    assert.deepEqual(await sweeper.sweep(Date.now() + DAY), [], 'not idle long enough');
    const archived = await sweeper.sweep(Date.now() + 4 * DAY);
    assert.ok(archived.includes(childId));
    assert.ok(!archived.includes(other.nodeId), 'ignored files mean asking, so the sweep skips it');
    assert.equal(store.getNode(other.nodeId)!.archived_at, null);

    const use = await storageUse(store);
    assert.equal(use.archived, archived.length);
    assert.ok(use.bytes > 0);
  });

  test('an archived experiment can still be deleted', async () => {
    const { childId } = await experiment();
    await run(childId, { 'app.py': 'print(3)\n' });
    const node = store.getNode(childId)!;
    await archiveFolder(store, node, false);
    await deleteNodeTree(store, childId);
    assert.equal(store.getNode(childId), undefined);
    assert.equal(
      await branchExists(store.getProject(node.project_id)!.repo_path, node.branch_name!),
      false,
    );
  });

  test('the sweep does nothing when automatic archiving is off', async () => {
    await experiment();
    const sweeper = new ArchiveSweeper({
      store,
      bus: new EventBus(),
      log: silentLogger,
      jobs: { isRunning: () => false, whileIdle: (_id, work) => work() },
      settings: { archiveAfterDays: () => null },
    });
    assert.deepEqual(await sweeper.sweep(Date.now() + 365 * DAY), []);
  });
});
