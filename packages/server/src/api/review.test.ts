import { createLegacyProject as createProject } from '../testing/legacyProject.js';
import { createAllocatedChild as createChildNode } from '../testing/allocatedChild.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { createChildNode as createNode } from '../projects.js';
import { commitMessageFor, commitRunOutput } from '../git/commit.js';
import { git } from '../git/exec.js';
import { reviewOf, reviewPatchOf } from './review.js';
import { branchOf, nodeRef } from '../git/refs.js';

/**
 * What review reads: one list of files with a status letter, and one file's
 * patch at a time.
 *
 * Committed work and work still sitting in the folder are one list, because
 * "what did this experiment do" has one answer. The letter says which is
 * which, and the counts come from git rather than from counting a patch.
 */
describe('an experiment’s changes, for review', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-review-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });
  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A run that writes files and commits, the way the pipeline records one. */
  async function run(nodeId: string, files: Record<string, string>): Promise<void> {
    const node = store.getNode(nodeId)!;
    const project = store.getProject(node.project_id)!;
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(node.worktree_path, path)), { recursive: true });
      await writeFile(join(node.worktree_path, path), content, 'utf8');
    }
    const outcome = await commitRunOutput({
      repoPath: project.repo_path,
      worktreePath: node.worktree_path,
      branchName: branchOf(node),
      ref: nodeRef(node.project_id, nodeId),
      message: commitMessageFor(node.display_name, node.description),
      baseCommit: node.base_commit,
    });
    const runId = `run-${Object.keys(files).join('-')}-${Math.random()}`;
    store.createRun(runId, nodeId);
    if (outcome.committed) store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
    store.finishRun(
      runId,
      { status: 'done', reason: 'finished', error: null },
      { cost: 0, inputTokens: 0, outputTokens: 0, commitSha: outcome.commit },
    );
  }

  test('full-file review includes unchanged lines, dirty content and deleted content without following paths', async () => {
    const { masterNodeId } = await createProject(store, {
      name: 'file-review',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    await run(masterNodeId, { 'code.txt': 'first\nunchanged\nlast\n' });
    const row = store.getNode(masterNodeId)!;
    await writeFile(join(row.worktree_path, 'code.txt'), 'updated\nunchanged\nlast\n');
    assert.equal(
      (await reviewPatchOf(store, row, 'code.txt', true)).content,
      'updated\nunchanged\nlast\n',
    );
    await assert.rejects(reviewPatchOf(store, row, '../outside', true), /did not change/);
    const child = await createChildNode(store, {
      projectId: row.project_id,
      parentId: row.id,
      displayName: 'deletion',
      description: '',
    });
    const childRow = store.getNode(child.nodeId)!;
    await unlink(join(childRow.worktree_path, 'code.txt'));
    const deleted = await reviewPatchOf(store, childRow, 'code.txt', true);
    assert.equal(deleted.content, 'first\nunchanged\nlast\n');
    assert.equal(deleted.contentRevision, 'before-deletion');
  });

  test('a child shows its own step by default, and its whole line when asked, before it has a folder', async () => {
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    await run(masterNodeId, { 'base.py': 'x\n' });
    const a = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'A',
      description: '',
    });
    await run(a.nodeId, { 'login.py': 'login\n', 'base.py': 'y\n' });
    // Created and never run: no folder, and nothing of its own yet.
    const b = await createNode(store, {
      projectId,
      parentId: a.nodeId,
      displayName: 'B',
      description: '',
    });
    const fresh = store.getNode(b.nodeId)!;
    assert.equal(fresh.worktree_allocated, 0);

    const own = await reviewOf(store, fresh);
    assert.deepEqual([own.scope, own.files.length], ['own', 0]);
    assert.deepEqual(own.scopes, { own: 0, line: 2 });
    assert.deepEqual(own.line, ['master', 'A', 'B']);

    const line = await reviewOf(store, fresh, 'line');
    // What it inherited from A, not master's own base.py commit before A.
    assert.deepEqual(
      line.files.map((f) => [f.path, f.status]),
      [
        ['base.py', 'M'],
        ['login.py', 'A'],
      ],
    );
    assert.match(line.baseLabel, /master had when this line began/);
    assert.match((await reviewPatchOf(store, fresh, 'login.py', false, 'line')).patch, /\+login/);

    // Master and its direct children have one step: nothing to switch.
    assert.equal((await reviewOf(store, store.getNode(masterNodeId)!)).scopes, null);
    assert.equal((await reviewOf(store, store.getNode(a.nodeId)!)).scopes, null);
    // The card knows without git: B started from a commit A made; A from master's.
    const cards = new Map(store.treeView(projectId).map((n) => [n.id, n]));
    assert.equal(cards.get(b.nodeId)!.inherits, true);
    assert.equal(cards.get(a.nodeId)!.inherits, false);
    assert.equal(cards.get(masterNodeId)!.inherits, false);
  });

  test('committed and uncommitted work are one list, each file with its letter', async () => {
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    await run(masterNodeId, { 'base.py': 'x\n', 'gone.txt': 'bye\n' });
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'chunking experiment',
      description: 'd',
    });
    // A run of its own: one file added, one modified, one deleted.
    const node = store.getNode(nodeId)!;
    await unlink(join(node.worktree_path, 'gone.txt'));
    await run(nodeId, { 'chunks/one.md': 'a\nb\n', 'base.py': 'x\ny\n' });
    // And work since, still in the folder.
    await writeFile(join(node.worktree_path, 'base.py'), 'x\ny\nz\n', 'utf8');
    await writeFile(join(node.worktree_path, 'scratch/notes.txt'), '', 'utf8').catch(async () => {
      await mkdir(join(node.worktree_path, 'scratch'), { recursive: true });
      await writeFile(join(node.worktree_path, 'scratch/notes.txt'), 'wip\n', 'utf8');
    });

    const review = await reviewOf(store, store.getNode(nodeId)!);
    const byPath = new Map(review.files.map((f) => [f.path, f]));
    assert.equal(review.displayName, 'chunking experiment');
    assert.match(review.baseLabel, /inherited code snapshot from master/);
    assert.equal(byPath.get('chunks/one.md')?.status, 'A');
    assert.equal(byPath.get('chunks/one.md')?.additions, 2);
    assert.equal(byPath.get('gone.txt')?.status, 'D');
    assert.equal(byPath.get('scratch/notes.txt')?.status, 'U', 'not tracked yet');
    assert.equal(byPath.get('scratch/notes.txt')?.uncommitted, true);
    // Changed in a commit and again since: shown once, as it is now.
    assert.equal(byPath.get('base.py')?.status, 'M');
    assert.equal(byPath.get('base.py')?.uncommitted, true);
    assert.equal(review.totals.files, review.files.length);

    // A file's patch comes from where that file's change is.
    assert.match(
      (await reviewPatchOf(store, store.getNode(nodeId)!, 'chunks/one.md')).patch,
      /\+a/,
    );
    assert.match(
      (await reviewPatchOf(store, store.getNode(nodeId)!, 'scratch/notes.txt')).patch,
      /\+wip/,
    );
    assert.match((await reviewPatchOf(store, store.getNode(nodeId)!, 'base.py')).patch, /\+z/);
  });

  test('a file this experiment never changed cannot be read through review', async () => {
    const { masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    await run(masterNodeId, { 'kept.py': 'x\n' });
    const row = store.getNode(masterNodeId)!;
    for (const path of ['../../etc/passwd', '--output=/tmp/x', 'never-touched.py']) {
      await assert.rejects(reviewPatchOf(store, row, path), { status: 404 });
    }
  });

  test('an experiment that has changed nothing reviews as an empty list', async () => {
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    await run(masterNodeId, { 'base.py': 'x\n' });
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'question only',
      description: 'd',
    });
    const review = await reviewOf(store, store.getNode(nodeId)!);
    assert.deepEqual(review.files, []);
    assert.deepEqual(review.totals, { files: 0, added: 0, removed: 0 });
  });

  test('renames name both sides, and binary files are listed without counts', async () => {
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await run(masterNodeId, { 'old name.py': long });
    // A child, so the file exists in the code it starts from: a rename inside
    // one experiment's whole range is just an add, which is what it is.
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'renamer',
      description: 'd',
    });
    const node = store.getNode(nodeId)!;
    await git(['mv', 'old name.py', 'new name.py'], node.worktree_path);
    await writeFile(join(node.worktree_path, 'model.bin'), Buffer.from([0, 1, 2, 0, 255]));
    await run(nodeId, {});

    const review = await reviewOf(store, store.getNode(nodeId)!);
    const byPath = new Map(review.files.map((f) => [f.path, f]));
    assert.equal(byPath.get('new name.py')?.status, 'R');
    assert.equal(byPath.get('new name.py')?.oldPath, 'old name.py');
    assert.equal(byPath.get('model.bin')?.binary, true);
    assert.match(
      (await reviewPatchOf(store, store.getNode(nodeId)!, 'new name.py')).patch,
      /rename from old name\.py/,
    );
  });
});
