import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { createChildNode, createProject, deleteNodeTree } from '../projects.js';
import { commitMessageFor, commitRunOutput, currentBranch } from './commit.js';
import { branchNameFor } from './repo.js';
import { nodeDiff } from './diff.js';
import { gitLine } from './exec.js';

/**
 * Integration tests against real git in temp directories. No mocks: the point
 * of M2 is that the git behaviour is real, and a fake git would prove nothing
 * about the one thing this milestone exists to verify.
 */
describe('git layer', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-git-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Stands in for the agent: writes files into a worktree, then commits. */
  async function run(nodeId: string, files: Record<string, string>): Promise<boolean> {
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
      message: commitMessageFor(node.display_name, node.description),
    });
    if (outcome.committed) store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
    return outcome.committed;
  }

  async function newProject(): Promise<{ projectId: string; masterNodeId: string }> {
    return createProject(store, {
      name: 'demo',
      description: 'a demo project',
      model: null,
      permissionMode: 'acceptEdits',
    });
  }

  test('project creation writes a root commit before master has a worktree', async () => {
    const { projectId, masterNodeId } = await newProject();
    const master = store.getNode(masterNodeId)!;
    const project = store.getProject(projectId)!;

    assert.notEqual(master.head_commit, null, 'the termination invariant requires this');
    assert.equal(master.branch_name, 'master');
    assert.equal(master.base_commit, null, 'master is the one node with no base');
    assert.ok(existsSync(master.worktree_path));
    assert.equal(await currentBranch(master.worktree_path), 'master');
    // D21: "do nothing" still yields a repo with an initial commit.
    assert.equal(await gitLine(['rev-list', '--count', 'master'], project.repo_path), '1');
  });

  test('a new node gets a detached worktree at its pinned base', async () => {
    const { projectId, masterNodeId } = await newProject();
    const master = store.getNode(masterNodeId)!;
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'a',
      description: 'approach a',
    });
    const node = store.getNode(nodeId)!;

    assert.equal(node.branch_name, null, 'the ref is deferred until a commit');
    assert.equal(node.head_commit, null);
    assert.equal(node.base_commit, master.head_commit);
    assert.equal(await currentBranch(node.worktree_path), null, 'must be detached');
  });

  test('a run that changes files creates the branch and commits', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'a',
      description: 'approach a',
    });

    assert.equal(await run(nodeId, { 'cli.py': 'print("a")\n' }), true);
    const node = store.getNode(nodeId)!;
    assert.equal(node.branch_name, `node/${nodeId}`);
    assert.notEqual(node.head_commit, null);
    assert.equal(await currentBranch(node.worktree_path), `node/${nodeId}`);
  });

  test('a run that changes nothing leaves no branch and no commit', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'question',
      description: 'just asking',
    });

    // CONTEXT.md alone is not a change (D28 would otherwise make every node
    // commit, which would delete the emergent model entirely).
    assert.equal(await run(nodeId, { 'CONTEXT.md': '# Context\n\nAsked a question.\n' }), false);
    const node = store.getNode(nodeId)!;
    assert.equal(node.branch_name, null);
    assert.equal(node.head_commit, null);
    assert.equal(await currentBranch(node.worktree_path), null);
  });

  test('CONTEXT.md from a no-op run does not ride into the next commit', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'n',
      description: 'd',
    });
    const node = store.getNode(nodeId)!;

    await run(nodeId, { 'CONTEXT.md': '# stale notes from a question\n' });
    assert.equal(
      existsSync(join(node.worktree_path, 'CONTEXT.md')),
      false,
      'an untracked CONTEXT.md left by a no-op run must be cleaned up',
    );

    await run(nodeId, { 'cli.py': 'print("x")\n', 'CONTEXT.md': '# real notes\n' });
    const committed = await readFile(join(node.worktree_path, 'CONTEXT.md'), 'utf8');
    assert.match(committed, /real notes/);
    assert.doesNotMatch(committed, /stale/);
  });

  test('a tracked CONTEXT.md is restored, not deleted, by a later no-op run', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'n',
      description: 'd',
    });
    const node = store.getNode(nodeId)!;

    await run(nodeId, { 'cli.py': 'print(1)\n', 'CONTEXT.md': '# committed notes\n' });
    // Second run answers a question: CONTEXT.md is now tracked, so the revert
    // path is `restore`, not `clean`. This is D31's untracked trap in reverse.
    assert.equal(await run(nodeId, { 'CONTEXT.md': '# scratch\n' }), false);
    assert.equal(
      await readFile(join(node.worktree_path, 'CONTEXT.md'), 'utf8'),
      '# committed notes\n',
    );
  });

  test('a node may hold several commits while it is a leaf (D29)', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'a',
      description: 'd',
    });
    await run(nodeId, { 'one.txt': '1' });
    const first = store.getNode(nodeId)!.head_commit;
    await run(nodeId, { 'two.txt': '2' });
    const second = store.getNode(nodeId)!.head_commit;

    assert.notEqual(first, second);
    const project = store.getProject(projectId)!;
    assert.equal(await gitLine(['rev-list', '--count', `node/${nodeId}`], project.repo_path), '3');
  });

  /**
   * THE M2 CHECKPOINT.
   *
   * A node whose parent has no commits of its own must branch from the correct
   * grandparent commit.
   */
  test('CHECKPOINT: a child of a commitless node branches from its grandparent', async () => {
    const { projectId, masterNodeId } = await newProject();

    const { nodeId: aId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'argparse',
      description: 'build it on argparse',
    });
    await run(aId, { 'cli.py': 'import argparse\n' });
    const aCommit = store.getNode(aId)!.head_commit!;

    // A question. Runs, writes nothing, so it never gets a branch or a commit.
    const { nodeId: eId } = await createChildNode(store, {
      projectId,
      parentId: aId,
      displayName: 'why argparse?',
      description: 'how do subcommands work here?',
    });
    await run(eId, { 'CONTEXT.md': '# answered\n' });
    assert.equal(store.getNode(eId)!.head_commit, null, 'setup: this node must have no commit');

    // The child of that node. Its git base must skip straight to A's commit.
    const { nodeId: fId, baseCommit } = await createChildNode(store, {
      projectId,
      parentId: eId,
      displayName: 'add --verbose',
      description: 'add the flag',
    });

    assert.equal(baseCommit, aCommit, 'must branch from the grandparent, not the parent');
    assert.equal(store.getNode(fId)!.base_commit, aCommit);

    // And prove it in git, not just in the database: the new worktree's HEAD
    // is A's commit, and A's file is present in it.
    const f = store.getNode(fId)!;
    assert.equal(await gitLine(['rev-parse', 'HEAD'], f.worktree_path), aCommit);
    assert.ok(existsSync(join(f.worktree_path, 'cli.py')), "the grandparent's code must be here");

    await run(fId, { 'verbose.py': 'x\n' });
    const project = store.getProject(projectId)!;
    const parents = await gitLine(
      ['rev-list', '--parents', '-n', '1', store.getNode(fId)!.head_commit!],
      project.repo_path,
    );
    assert.ok(parents.endsWith(aCommit), "the commit's parent must be the grandparent commit");
  });

  test('CHECKPOINT: the walk survives chained commitless nodes', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId: aId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'a',
      description: 'd',
    });
    await run(aId, { 'cli.py': 'x\n' });
    const aCommit = store.getNode(aId)!.head_commit!;

    let parentId = aId;
    for (const name of ['q1', 'q2', 'q3']) {
      const { nodeId } = await createChildNode(store, {
        projectId,
        parentId,
        displayName: name,
        description: 'a question',
      });
      await run(nodeId, { 'CONTEXT.md': `# ${name}\n` });
      assert.equal(store.getNode(nodeId)!.head_commit, null);
      parentId = nodeId;
    }

    const { baseCommit } = await createChildNode(store, {
      projectId,
      parentId,
      displayName: 'finally',
      description: 'do the work',
    });
    assert.equal(baseCommit, aCommit, 'three hops up, still A');
  });

  test('an ancestor committing later does not move an existing subtree', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId: aId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'a',
      description: 'd',
    });
    await run(aId, { 'one.txt': '1' });
    const firstCommit = store.getNode(aId)!.head_commit!;

    const { nodeId: eId } = await createChildNode(store, {
      projectId,
      parentId: aId,
      displayName: 'q',
      description: 'a question',
    });
    await run(eId, { 'CONTEXT.md': '# q\n' });

    // A is still writable: its only child committed nothing. So it runs again.
    await run(aId, { 'two.txt': '2' });
    assert.notEqual(store.getNode(aId)!.head_commit, firstCommit);

    // The pin holds. E's child lands where E was born, so its code and its
    // inherited conversation still describe the same tree.
    const { baseCommit } = await createChildNode(store, {
      projectId,
      parentId: eId,
      displayName: 'child',
      description: 'd',
    });
    assert.equal(baseCommit, firstCommit);
    assert.equal(store.baseDiverges(store.getNode(eId)!), true, 'and it is reported');
  });

  test('diff is measured against the pinned base, not the parent', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'a',
      description: 'd',
    });
    await run(nodeId, { 'cli.py': 'print(1)\n', 'CONTEXT.md': '# notes\n' });
    const node = store.getNode(nodeId)!;

    const diff = await nodeDiff(node.worktree_path, node.base_commit!, true);
    // CONTEXT.md does not count as a *change* but is still committed alongside
    // one, so it belongs in the diff.
    assert.deepEqual(diff.files.sort(), ['CONTEXT.md', 'cli.py']);
    assert.match(diff.patch, /print\(1\)/);
    assert.deepEqual(diff.dirty, [], 'a committed worktree is clean');
  });

  test('deleting a node cascades, removing worktrees and branches', async () => {
    const { projectId, masterNodeId } = await newProject();
    const { nodeId: aId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'a',
      description: 'd',
    });
    await run(aId, { 'a.txt': 'a' });
    const { nodeId: bId } = await createChildNode(store, {
      projectId,
      parentId: aId,
      displayName: 'b',
      description: 'd',
    });
    await run(bId, { 'b.txt': 'b' });

    const aPath = store.getNode(aId)!.worktree_path;
    const bPath = store.getNode(bId)!.worktree_path;
    const project = store.getProject(projectId)!;

    const removed = await deleteNodeTree(store, aId);
    assert.equal(removed, 2, 'the node and its descendant');
    assert.equal(existsSync(aPath), false);
    assert.equal(existsSync(bPath), false);
    assert.equal(store.getNode(bId), undefined, 'the cascade reached the child row');

    const branches = await gitLine(['branch', '--format=%(refname:short)'], project.repo_path);
    assert.equal(branches, 'master', 'only master should remain');
  });
});
