import { createLegacyProject as createProject } from '../testing/legacyProject.js';
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';

import { createAllocatedChild } from '../testing/allocatedChild.js';
import { silentLogger } from '../log.js';
import { git, gitLine } from './exec.js';
import { commitRunOutput } from './commit.js';
import { expectedGitState } from './ownership.js';
import { nodeRef, readRef } from './refs.js';
import { recoverRunSaves } from './saveRecovery.js';
import { gitRecovery, synchronizeExperiment } from './reconcile.js';
import { exportExperiment } from './export.js';

let root: string;
let db: ReturnType<typeof openDatabase>;
let store: Store;
let projectId: string;
let nodeId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bonsai-sync-'));
  db = openDatabase(root);
  store = new Store(db, join(root, 'repos'));
  const created = await createProject(store, {
    name: 'recovery',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  projectId = created.projectId;
  nodeId = (
    await createAllocatedChild(store, {
      projectId,
      parentId: created.masterNodeId,
      displayName: 'experiment',
      description: '',
    })
  ).nodeId;
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

for (const crashAt of [
  'before Git moves',
  'after Git moves',
  'between legacy HEAD and ref writes',
] as const) {
  test(`an exact durable save recovers ${crashAt}, after reopening the database`, async () => {
    const node = store.getNode(nodeId)!;
    const repo = store.getProject(projectId)!.repo_path;
    const before = await expectedGitState(repo, node);
    store.enqueueRun('save-run', nodeId, {
      prompt: 'write file',
      command: false,
      referenceIds: [],
      experimentIds: [],
    });
    await writeFile(join(node.worktree_path, 'work.txt'), 'finished work\n');
    let after = '';
    const commit = commitRunOutput({
      repoPath: repo,
      worktreePath: node.worktree_path,
      branchName: null,
      ref: nodeRef(projectId, nodeId),
      message: 'Bonsai save',
      expectedState: before,
      prepareSave: async (_old, outcome) => {
        after = outcome.commit!;
        store.saves.prepare({
          runId: 'save-run',
          nodeId,
          projectId,
          repoPath: repo,
          worktreePath: node.worktree_path,
          before,
          after,
          totals: {
            cost: 0.42,
            inputTokens: 30,
            outputTokens: 10,
            commitSha: after,
            stat: outcome.stat,
            change: outcome.ownStat,
          },
          node: {
            status: 'ready',
            commit: { branch: nodeRef(projectId, nodeId), head: after },
            sessionPosition: 'last-message',
          },
        });
        if (crashAt === 'between legacy HEAD and ref writes')
          await git(['update-ref', '--no-deref', 'HEAD', after, before.head], node.worktree_path);
        if (crashAt !== 'after Git moves') throw new Error('injected crash');
      },
    });
    if (crashAt === 'after Git moves') await commit;
    else await assert.rejects(commit, /injected crash/);
    db.close();
    db = openDatabase(root);
    store = new Store(db, join(root, 'repos'));
    store.markOrphanedRunsInterrupted();
    assert.equal(await recoverRunSaves(store, silentLogger), 1);
    assert.equal(store.getNode(nodeId)!.head_commit, after);
    assert.equal(store.getNode(nodeId)!.status, 'ready');
    assert.equal(store.getNode(nodeId)!.session_position, 'last-message');
    assert.equal(store.getRun('save-run')!.status, 'done');
    assert.equal(store.listRuns(nodeId)[0]!.costUsd, 0.42);
    assert.equal(await gitLine(['rev-parse', 'HEAD'], node.worktree_path), after);
    assert.equal(await readRef(repo, nodeRef(projectId, nodeId)), after);
    assert.equal(store.saves.pending().length, 0);
    assert.equal(await recoverRunSaves(store, silentLogger), 0);
  });
}

test('a save journal cannot bless a later external commit', async () => {
  const node = store.getNode(nodeId)!;
  const repo = store.getProject(projectId)!.repo_path;
  const before = await expectedGitState(repo, node);
  store.enqueueRun('run', nodeId, {
    prompt: 'work',
    command: false,
    referenceIds: [],
    experimentIds: [],
  });
  await writeFile(join(node.worktree_path, 'work'), 'own work');
  await commitRunOutput({
    repoPath: repo,
    worktreePath: node.worktree_path,
    branchName: null,
    ref: nodeRef(projectId, nodeId),
    message: 'save',
    expectedState: before,
    prepareSave: (_old, outcome) => {
      store.saves.prepare({
        runId: 'run',
        nodeId,
        projectId,
        repoPath: repo,
        worktreePath: node.worktree_path,
        before,
        after: outcome.commit!,
        totals: { cost: 0, inputTokens: 0, outputTokens: 0 },
        node: {
          status: 'ready',
          commit: { branch: nodeRef(projectId, nodeId), head: outcome.commit! },
        },
      });
      return Promise.resolve();
    },
  });
  await writeFile(join(node.worktree_path, 'external'), 'outside');
  await git(['add', '-A'], node.worktree_path);
  await git(['commit', '-m', 'external'], node.worktree_path);
  const external = await gitLine(['rev-parse', 'HEAD'], node.worktree_path);
  assert.equal(await recoverRunSaves(store, silentLogger), 0);
  assert.equal(await gitLine(['rev-parse', 'HEAD'], node.worktree_path), external);
  assert.equal(store.getNode(nodeId)!.head_commit, null);
  assert.equal(store.saves.pending().length, 1);
  assert.equal((await gitRecovery(store, node))?.canImportFolder, true);
});

test('explicit import preserves ignored files, staged-only content and old tips, and future runs work', async () => {
  const node = store.getNode(nodeId)!;
  const repo = store.getProject(projectId)!.repo_path;
  const old = node.base_commit!;
  await writeFile(join(node.worktree_path, '.gitignore'), '.env\n');
  await writeFile(join(node.worktree_path, 'external.txt'), 'committed external\n');
  await git(['add', '-A'], node.worktree_path);
  await git(['commit', '-m', 'external'], node.worktree_path);
  const external = await gitLine(['rev-parse', 'HEAD'], node.worktree_path);
  await writeFile(join(node.worktree_path, 'external.txt'), 'staged-only\n');
  await git(['add', 'external.txt'], node.worktree_path);
  await writeFile(join(node.worktree_path, 'external.txt'), 'working-files\n');
  await writeFile(join(node.worktree_path, 'new.txt'), 'new work');
  await writeFile(join(node.worktree_path, '.env'), 'modified ignored canary');
  const recovery = (await gitRecovery(store, node))!;
  const preserved = await synchronizeExperiment(store, node, 'import-folder', recovery.version);
  assert.equal(await readFile(join(preserved, '.env'), 'utf8'), 'modified ignored canary');
  assert.equal(await git(['show', 'preserved-staged:external.txt'], preserved), 'staged-only\n');
  assert.equal(await gitLine(['rev-parse', 'preserved-recorded'], preserved), old);
  assert.equal(await gitLine(['rev-parse', 'preserved-folder'], preserved), external);
  assert.equal(await readFile(join(node.worktree_path, 'external.txt'), 'utf8'), 'working-files\n');
  assert.equal(await gitRecovery(store, store.getNode(nodeId)!), null);
  await writeFile(join(node.worktree_path, 'next.txt'), 'next run');
  const next = await commitRunOutput({
    repoPath: repo,
    worktreePath: node.worktree_path,
    branchName: null,
    ref: nodeRef(projectId, nodeId),
    expectedState: await expectedGitState(repo, store.getNode(nodeId)!),
    message: 'next',
  });
  assert.equal(next.committed, true);
});

test('explicit restore preserves an unexpected branch and all files, while rejecting stale choices', async () => {
  const node = store.getNode(nodeId)!;
  await git(['checkout', '-b', 'user-branch'], node.worktree_path);
  await writeFile(join(node.worktree_path, 'outside.txt'), 'keep me');
  await git(['add', '-A'], node.worktree_path);
  await git(['commit', '-m', 'outside'], node.worktree_path);
  const head = await gitLine(['rev-parse', 'HEAD'], node.worktree_path);
  const recovery = (await gitRecovery(store, node))!;
  await assert.rejects(synchronizeExperiment(store, node, 'restore', 'stale'), /Refresh/);
  const preserved = await synchronizeExperiment(store, node, 'restore', recovery.version);
  assert.equal(await readFile(join(preserved, 'outside.txt'), 'utf8'), 'keep me');
  assert.equal(await gitLine(['rev-parse', 'user-branch'], node.worktree_path), head);
  assert.equal(await gitLine(['rev-parse', 'HEAD'], node.worktree_path), node.base_commit);
  assert.equal(await gitRecovery(store, store.getNode(nodeId)!), null);
});

test('a missing owned folder can be restored from its recorded Git snapshot', async () => {
  const node = store.getNode(nodeId)!;
  await rm(node.worktree_path, { recursive: true });
  const recovery = (await gitRecovery(store, node))!;
  assert.equal(recovery.problem, 'missing_folder');
  assert.equal(recovery.canRestore, true);
  await synchronizeExperiment(store, node, 'restore', recovery.version);
  assert.equal(await gitRecovery(store, store.getNode(nodeId)!), null);
});

test('restoring a conflicted checkout preserves every merge stage and refuses importing unresolved markers', async () => {
  const node = store.getNode(nodeId)!;
  await writeFile(join(node.worktree_path, 'conflict.txt'), 'base\n');
  await git(['add', '-A'], node.worktree_path);
  await git(['commit', '-m', 'base'], node.worktree_path);
  const base = await gitLine(['rev-parse', 'HEAD'], node.worktree_path);
  await git(['checkout', '-b', 'theirs'], node.worktree_path);
  await writeFile(join(node.worktree_path, 'conflict.txt'), 'their version\n');
  await git(['add', '-A'], node.worktree_path);
  await git(['commit', '-m', 'theirs'], node.worktree_path);
  await git(['checkout', '--detach', base], node.worktree_path);
  await writeFile(join(node.worktree_path, 'conflict.txt'), 'our version\n');
  await git(['add', '-A'], node.worktree_path);
  await git(['commit', '-m', 'ours'], node.worktree_path);
  await assert.rejects(git(['merge', 'theirs'], node.worktree_path));
  const recovery = (await gitRecovery(store, node))!;
  assert.equal(recovery.canImportFolder, false);
  assert.match(recovery.message, /unresolved merge conflicts/);
  const preserved = await synchronizeExperiment(store, node, 'restore', recovery.version);
  assert.equal(await git(['show', 'preserved-stage-1:conflict.txt'], preserved), 'base\n');
  assert.equal(await git(['show', 'preserved-stage-2:conflict.txt'], preserved), 'our version\n');
  assert.equal(await git(['show', 'preserved-stage-3:conflict.txt'], preserved), 'their version\n');
  assert.match(await readFile(join(preserved, 'conflict.txt'), 'utf8'), /<<<<<<< HEAD/);
  assert.equal(await gitRecovery(store, store.getNode(nodeId)!), null);
});

test('an exported repository survives removing Bonsai storage and keeps independent history', async () => {
  const node = store.getNode(nodeId)!;
  await writeFile(join(node.worktree_path, 'saved.txt'), 'complete code');
  await git(['add', '-A'], node.worktree_path);
  await git(['commit', '-m', 'saved'], node.worktree_path);
  const head = await gitLine(['rev-parse', 'HEAD'], node.worktree_path);
  const exported = await exportExperiment(
    store.getProject(projectId)!.repo_path,
    head,
    join(root, 'exports'),
    'code',
  );
  await rm(join(root, 'repos'), { recursive: true });
  assert.equal(await readFile(join(exported, 'saved.txt'), 'utf8'), 'complete code');
  assert.equal(await gitLine(['rev-parse', 'HEAD'], exported), head);
  assert.equal(await gitLine(['remote'], exported), '');
  assert.equal(await gitLine(['rev-list', '--count', 'HEAD'], exported), '2');
  await git(['fsck', '--no-dangling'], exported);
});
