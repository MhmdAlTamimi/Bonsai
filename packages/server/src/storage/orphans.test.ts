import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile, copyFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import { createProject, allocateNodeWorktree, deleteProjectTree } from '../projects.js';
import { createAllocatedChild } from '../testing/allocatedChild.js';
import { git, gitLine } from '../git/exec.js';
import { nodeRef, moveRef } from '../git/refs.js';
import { lostExperiments, importLostExperiment } from './orphans.js';
import { gitRecovery } from '../git/reconcile.js';

test('an older database discovers and recovers missing Git experiments without changing their files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-orphans-'));
  let db = openDatabase(root);
  try {
    let store = new Store(db, join(root, 'repos'));
    const project = await createProject(store, {
      name: 'old backup',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const backup = join(root, 'older.db');
    db.prepare('VACUUM INTO ?').run(backup);
    const one = await createAllocatedChild(store, {
      projectId: project.projectId,
      parentId: project.masterNodeId,
      displayName: 'lost one',
      description: '',
    });
    const two = await createAllocatedChild(store, {
      projectId: project.projectId,
      parentId: project.masterNodeId,
      displayName: 'lost two',
      description: '',
    });
    const repo = store.getProject(project.projectId)!.repo_path;
    const node = store.getNode(one.nodeId)!;
    await writeFile(join(node.worktree_path, 'saved.txt'), 'saved work');
    await git(['add', '-A'], node.worktree_path);
    await git(['commit', '-qm', 'valuable experiment'], node.worktree_path);
    const head = await gitLine(['rev-parse', 'HEAD'], node.worktree_path);
    await moveRef(repo, nodeRef(project.projectId, node.id), head, node.base_commit!);
    await writeFile(join(node.worktree_path, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(node.worktree_path, 'ignored.txt'), 'ignored work');
    await writeFile(join(node.worktree_path, 'index.txt'), 'only staged');
    await git(['add', 'index.txt'], node.worktree_path);
    await rm(join(node.worktree_path, 'index.txt'));
    const index = await git(['ls-files', '--stage'], node.worktree_path);
    await git(['worktree', 'remove', '--force', store.getNode(two.nodeId)!.worktree_path], repo);
    db.close();
    await copyFile(backup, join(root, 'bonsai.db'));
    db = openDatabase(root);
    store = new Store(db, join(root, 'repos'));
    const found = await lostExperiments(store, project.projectId);
    assert.equal(found.length, 2);
    await assert.rejects(deleteProjectTree(store, project.projectId), /missing from this database/);
    assert.equal(await readFile(join(node.worktree_path, 'saved.txt'), 'utf8'), 'saved work');
    const item = found.find((item) => item.id === node.id)!;
    assert.equal(item.commit, head);
    assert.equal(item.folder, node.worktree_path);
    await assert.rejects(
      importLostExperiment(store, project.projectId, item.id, 'outdated', join(root, 'recovery')),
      /changed/,
    );
    const recovered = await importLostExperiment(
      store,
      project.projectId,
      item.id,
      item.version,
      join(root, 'recovery'),
    );
    assert.equal(recovered.nodeId, node.id);
    assert.equal(
      await git(['ls-files', '--stage'], node.worktree_path),
      index,
      'source index unchanged',
    );
    assert.equal(
      await readFile(join(recovered.preservedPath, 'ignored.txt'), 'utf8'),
      'ignored work',
    );
    assert.equal(
      await gitLine(['show', 'preserved-staged:index.txt'], recovered.preservedPath),
      'only staged',
    );
    await git(['fsck', '--no-dangling'], recovered.preservedPath);
    assert.equal(await gitRecovery(store, store.getNode(node.id)!), null);
    assert.equal((await lostExperiments(store, project.projectId)).length, 1);
    const archived = (await lostExperiments(store, project.projectId))[0]!;
    const result = await importLostExperiment(
      store,
      project.projectId,
      archived.id,
      archived.version,
      join(root, 'recovery'),
    );
    assert.equal(store.getNode(result.nodeId)!.worktree_allocated, 0);
    await allocateNodeWorktree(store, store.getNode(result.nodeId)!);
    assert.equal(await gitRecovery(store, store.getNode(result.nodeId)!), null);
    assert.equal((await lostExperiments(store, project.projectId)).length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
