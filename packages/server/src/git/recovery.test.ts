import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { createChildNode, createProject } from '../projects.js';
import { commitMessageFor, commitRunOutput } from './commit.js';
import { branchNameFor } from './repo.js';
import { discardWorktreeChanges, isDirty, readWorktreeState, resumePrompt } from './recovery.js';

describe('interrupted-run recovery (§6.6 / D31)', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-m4-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const project = async () =>
    createProject(store, { name: 'p', description: 'd', model: null, permissionMode: 'acceptEdits' });

  const commit = async (nodeId: string, files: Record<string, string>): Promise<void> => {
    const node = store.getNode(nodeId)!;
    const proj = store.getProject(node.project_id)!;
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(node.worktree_path, path), content, 'utf8');
    }
    const outcome = await commitRunOutput({
      repoPath: proj.repo_path,
      worktreePath: node.worktree_path,
      branchName: node.branch_name ?? branchNameFor(nodeId),
      message: commitMessageFor(node.display_name, node.description),
    });
    if (outcome.committed) store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
  };

  test('an untracked file left by a killed run is visible', async () => {
    const { masterNodeId } = await project();
    const node = store.getNode(masterNodeId)!;
    // Exactly D31's trap: plain `git diff` cannot see this file at all, and a
    // newly created one is the likeliest thing an interrupted run leaves.
    await writeFile(join(node.worktree_path, 'half-written.py'), 'def main():\n', 'utf8');

    const state = await readWorktreeState(node.worktree_path);
    assert.deepEqual(state.changed, ['half-written.py']);
    assert.deepEqual(state.untracked, ['half-written.py']);
    assert.equal(state.patch, '', 'git diff is blind to it, which is the point');
  });

  test('the resume prompt names untracked files explicitly', async () => {
    const { masterNodeId } = await project();
    const node = store.getNode(masterNodeId)!;
    await writeFile(join(node.worktree_path, 'new.py'), 'x = 1\n', 'utf8');

    const prompt = resumePrompt(await readWorktreeState(node.worktree_path), 'build a CLI');
    assert.match(prompt, /new\.py/);
    assert.match(prompt, /did not exist before/);
    assert.match(prompt, /build a CLI/);
    assert.match(prompt, /Do not redo work that is already present/);
  });

  test('the resume prompt carries the tracked diff too', async () => {
    const { masterNodeId } = await project();
    await commit(masterNodeId, { 'cli.py': 'print(1)\n' });
    const node = store.getNode(masterNodeId)!;
    await writeFile(join(node.worktree_path, 'cli.py'), 'print(2)\n', 'utf8');

    const prompt = resumePrompt(await readWorktreeState(node.worktree_path), 'change it');
    assert.match(prompt, /```diff/);
    assert.match(prompt, /print\(2\)/);
  });

  test('a clean worktree resumes from the beginning instead of pretending', async () => {
    const { masterNodeId } = await project();
    const node = store.getNode(masterNodeId)!;
    const prompt = resumePrompt(await readWorktreeState(node.worktree_path), 'build a CLI');
    assert.match(prompt, /nothing you did was saved/);
    assert.match(prompt, /start again from the beginning/);
  });

  test('discard removes untracked files as well as reverting tracked ones', async () => {
    const { masterNodeId } = await project();
    await commit(masterNodeId, { 'cli.py': 'print(1)\n' });
    const node = store.getNode(masterNodeId)!;

    await writeFile(join(node.worktree_path, 'cli.py'), 'print(2)\n', 'utf8');
    await writeFile(join(node.worktree_path, 'stray.py'), 'junk\n', 'utf8');
    assert.equal(await isDirty(node.worktree_path), true);

    await discardWorktreeChanges(node.worktree_path);

    // `git checkout .` alone would have left stray.py behind -- a discard that
    // silently keeps half the changes is worse than not offering one.
    assert.equal(await isDirty(node.worktree_path), false);
    assert.equal(existsSync(join(node.worktree_path, 'stray.py')), false);
  });

  test('discard on a clean worktree is a no-op, not an error', async () => {
    const { masterNodeId } = await project();
    const node = store.getNode(masterNodeId)!;
    await discardWorktreeChanges(node.worktree_path);
    assert.equal(await isDirty(node.worktree_path), false);
  });

  test('keep leaves the work in place and still resumable', async () => {
    const { projectId, masterNodeId } = await project();
    await commit(masterNodeId, { 'a.py': '1\n' });
    const { nodeId } = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'n', description: 'd',
    });
    const node = store.getNode(nodeId)!;
    await writeFile(join(node.worktree_path, 'wip.py'), 'partial\n', 'utf8');

    // Keep touches nothing on disk; the state is still there to resume from.
    assert.equal(await isDirty(node.worktree_path), true);
    const state = await readWorktreeState(node.worktree_path);
    assert.deepEqual(state.untracked, ['wip.py']);
  });

  /**
   * THE M4 CHECKPOINT, in the form a test can hold: a run that died leaves the
   * node `interrupted` on reopen, with its work intact and resumable.
   */
  test('CHECKPOINT: a run killed mid-flight is interrupted on reopen, and recoverable', async () => {
    const { projectId, masterNodeId } = await project();
    await commit(masterNodeId, { 'base.py': 'x\n' });
    const { nodeId } = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'work', description: 'add a feature',
    });

    // A run starts, writes something, and the process dies before committing.
    const runId = 'run-killed';
    store.createRun(runId, nodeId);
    store.appendMessage({ nodeId, runId, role: 'user', kind: 'text', content: 'add a feature' });
    store.setNodeStatus(nodeId, 'running');
    const node = store.getNode(nodeId)!;
    await writeFile(join(node.worktree_path, 'feature.py'), 'half\n', 'utf8');

    // Reopen: anything still marked running died with the process (D31).
    const orphaned = store.markOrphanedRunsInterrupted();
    assert.equal(orphaned, 1);
    assert.equal(store.getNode(nodeId)!.status, 'interrupted');
    assert.equal(store.getNode(nodeId)!.head_commit, null, 'a killed run leaves no commit');

    // The work survived, and resume is told about it rather than guessing.
    const state = await readWorktreeState(node.worktree_path);
    assert.deepEqual(state.untracked, ['feature.py']);
    const prompt = resumePrompt(state, store.lastUserPrompt(nodeId)!);
    assert.match(prompt, /feature\.py/);
    assert.match(prompt, /add a feature/, 'the original request must survive the restart');
  });

  test('a resumed run commits normally once it finishes', async () => {
    const { projectId, masterNodeId } = await project();
    await commit(masterNodeId, { 'base.py': 'x\n' });
    const { nodeId } = await createChildNode(store, {
      projectId, parentId: masterNodeId, displayName: 'work', description: 'd',
    });
    const node = store.getNode(nodeId)!;

    await writeFile(join(node.worktree_path, 'feature.py'), 'half\n', 'utf8');
    // The resumed run finishes the job; the app commits everything present.
    await commit(nodeId, { 'feature.py': 'complete\n' });

    assert.notEqual(store.getNode(nodeId)!.head_commit, null);
    assert.equal(await isDirty(node.worktree_path), false);
  });
});
