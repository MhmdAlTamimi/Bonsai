import {
  createLegacyProject as createProject,
  adoptLegacyProject as adoptProject,
} from '../testing/legacyProject.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, mkdir, rename, cp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import { allocateNodeWorktree, deleteNodeTree } from '../projects.js';
import { createAllocatedChild } from '../testing/allocatedChild.js';
import { silentLogger } from '../log.js';
import { git, gitLine } from '../git/exec.js';
import { gitRecovery } from '../git/reconcile.js';
import { removeWorktree } from '../git/worktree.js';
import { relocateManagedStorage, locateRepository } from './relocate.js';
import { Settings } from '../settings.js';

let root: string;
let data: string;
let db: ReturnType<typeof openDatabase>;
let store: Store;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bonsai-move-test-'));
  data = join(root, 'old', 'data');
  db = openDatabase(data);
  store = new Store(db, join(data, 'repos'));
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
const created = () =>
  createProject(store, {
    name: 'moving',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
const reopen = (path: string) => {
  db.close();
  data = path;
  db = openDatabase(data);
  store = new Store(db, join(data, 'repos'));
};

for (const copy of [false, true])
  test(`managed storage ${copy ? 'copy' : 'move'} repairs paths without changing original storage`, async () => {
    const project = await created();
    const { nodeId } = await createAllocatedChild(store, {
      projectId: project.projectId,
      parentId: project.masterNodeId,
      displayName: 'child',
      description: '',
    });
    const old = store.getNode(nodeId)!;
    await writeFile(join(old.worktree_path, 'dirty.txt'), 'unsaved');
    await writeFile(join(old.worktree_path, '.gitignore'), 'ignored.txt\n');
    await writeFile(join(old.worktree_path, 'ignored.txt'), 'ignored but valuable');
    const archived = await createAllocatedChild(store, {
      projectId: project.projectId,
      parentId: nodeId,
      displayName: 'archived',
      description: '',
    });
    const archiveNode = store.getNode(archived.nodeId)!;
    await removeWorktree(store.getProject(project.projectId)!.repo_path, archiveNode.worktree_path);
    store.nodes.markArchived(archiveNode.id);
    await relocateManagedStorage(store, data, silentLogger);
    const moved = join(root, 'new', 'data');
    db.close();
    if (copy) await cp(data, moved, { recursive: true });
    else {
      await mkdir(join(root, 'new'), { recursive: true });
      await rename(data, moved);
    }
    db = openDatabase(moved);
    store = new Store(db, join(moved, 'repos'));
    await relocateManagedStorage(store, moved, silentLogger);
    const node = store.getNode(nodeId)!;
    assert.equal(node.worktree_path, old.worktree_path.replace(data, moved));
    assert.equal(await gitRecovery(store, node), null);
    assert.equal(await readFile(join(node.worktree_path, 'dirty.txt'), 'utf8'), 'unsaved');
    assert.equal(
      await readFile(join(node.worktree_path, 'ignored.txt'), 'utf8'),
      'ignored but valuable',
    );
    await allocateNodeWorktree(store, store.getNode(archived.nodeId)!);
    await git(['fsck', '--no-dangling'], store.getProject(project.projectId)!.repo_path);
    if (copy) {
      assert.equal(
        await gitLine(
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          old.worktree_path,
        ),
        join(data, 'repos', project.projectId, 'repo.git'),
      );
      assert.equal(await readFile(join(old.worktree_path, 'dirty.txt'), 'utf8'), 'unsaved');
    }
  });

test('a moved external repository requires a verified explicit choice and never resets its checkout', async () => {
  const code = join(root, 'old', 'code');
  await mkdir(code, { recursive: true });
  await git(['init', '-q', '--initial-branch=main'], code);
  await writeFile(join(code, 'app.txt'), 'source');
  await git(['add', '-A'], code);
  await git(['commit', '-qm', 'source'], code);
  const project = await adoptProject(store, {
    path: code,
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  const child = await createAllocatedChild(store, {
    projectId: project.projectId,
    parentId: project.masterNodeId,
    displayName: 'child',
    description: '',
  });
  await writeFile(join(code, 'uncommitted.txt'), 'source must stay');
  await writeFile(join(store.getNode(child.nodeId)!.worktree_path, 'own.txt'), 'child must stay');
  await relocateManagedStorage(store, data, silentLogger);
  db.close();
  await rename(join(root, 'old'), join(root, 'new'));
  data = join(root, 'new', 'data');
  db = openDatabase(data);
  store = new Store(db, join(data, 'repos'));
  await relocateManagedStorage(store, data, silentLogger);
  assert.equal(
    (await gitRecovery(store, store.getNode(child.nodeId)!))?.problem,
    'missing_repository',
  );
  const wrong = join(root, 'wrong');
  await mkdir(wrong);
  await git(['init', '-q', '--initial-branch=main'], wrong);
  await assert.rejects(locateRepository(store, project.projectId, wrong), /no saved Git identity/);
  const moved = join(root, 'new', 'code');
  await locateRepository(store, project.projectId, moved);
  assert.equal(await gitRecovery(store, store.getNode(child.nodeId)!), null);
  assert.equal(await readFile(join(moved, 'uncommitted.txt'), 'utf8'), 'source must stay');
  assert.equal(await gitLine(['branch', '--show-current'], moved), 'main');
  assert.equal(
    await readFile(join(store.getNode(child.nodeId)!.worktree_path, 'own.txt'), 'utf8'),
    'child must stay',
  );
});

test('a crash after Git repair retries its durable path move without guessing again', async () => {
  const project = await created();
  await relocateManagedStorage(store, data, silentLogger);
  const moved = join(root, 'moved');
  db.close();
  await rename(data, moved);
  db = openDatabase(moved);
  store = new Store(db, join(moved, 'repos'));
  db.exec(
    "CREATE TRIGGER fail_move BEFORE UPDATE OF repo_path ON project BEGIN SELECT RAISE(FAIL,'fixture relocation write failed'); END;",
  );
  await relocateManagedStorage(store, moved, silentLogger);
  assert.ok(store.metadata(`relocation:${project.projectId}`));
  reopen(moved);
  db.exec('DROP TRIGGER fail_move');
  await relocateManagedStorage(store, moved, silentLogger);
  assert.equal(store.metadata(`relocation:${project.projectId}`), null);
  assert.equal(await gitRecovery(store, store.getNode(project.masterNodeId)!), null);
});

test('deleting a missing checkout does not prune an unrelated missing worktree', async () => {
  const project = await created();
  const one = await createAllocatedChild(store, {
    projectId: project.projectId,
    parentId: project.masterNodeId,
    displayName: 'one',
    description: '',
  });
  const two = await createAllocatedChild(store, {
    projectId: project.projectId,
    parentId: project.masterNodeId,
    displayName: 'two',
    description: '',
  });
  const other = store.getNode(two.nodeId)!.worktree_path;
  await rm(other, { recursive: true, force: true });
  await deleteNodeTree(store, one.nodeId);
  const repo = store.getProject(project.projectId)!.repo_path;
  // Missing, unregistered target exercises the remove fallback without global pruning.
  await removeWorktree(repo, join(root, 'already-gone'));
  assert.ok(
    (await git(['worktree', 'list', '--porcelain', '-z'], repo))
      .split('\0')
      .includes(`worktree ${other}`),
  );
});

test('stored managed location moves with data; an external preference stays explicit', () => {
  const settings = new Settings({
    dataDir: data,
    reposRoot: join(data, 'repos'),
    port: 8787,
    defaultModel: null,
    defaultPermissionMode: 'acceptEdits',
  });
  settings.update({ reposRoot: join(data, 'custom-repos') });
  const moved = join(root, 'new', 'data');
  settings.relocateStorageRoot(data, moved);
  assert.equal(settings.reposRoot(), join(moved, 'custom-repos'));
  settings.update({ reposRoot: join(root, 'external-repos') });
  settings.relocateStorageRoot(data, moved);
  assert.equal(settings.reposRoot(), join(root, 'external-repos'));
});
