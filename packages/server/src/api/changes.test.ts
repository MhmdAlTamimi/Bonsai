import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { createChildNode, createProject } from '../projects.js';
import { commitMessageFor, commitRunOutput } from '../git/commit.js';
import { branchNameFor } from '../git/repo.js';
import { changedFilePatch, experimentChanges, runChanges } from './changes.js';

/**
 * The Changes tab's three views of an experiment, and the rule that a file can
 * only be opened from a change it belongs to.
 */
describe('an experiment’s changes, by scope', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-change-scope-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });
  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A run that writes files and commits, recorded the way the pipeline records it. */
  async function run(nodeId: string, files: Record<string, string>): Promise<string> {
    const node = store.getNode(nodeId)!;
    const project = store.getProject(node.project_id)!;
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(node.worktree_path, path)), { recursive: true });
      await writeFile(join(node.worktree_path, path), content, 'utf8');
    }
    const outcome = await commitRunOutput({
      repoPath: project.repo_path,
      worktreePath: node.worktree_path,
      branchName: node.branch_name ?? branchNameFor(nodeId),
      message: commitMessageFor(node.display_name, node.description),
      baseCommit: node.base_commit,
    });
    const runId = `run-${Object.keys(files).join('-')}`;
    store.createRun(runId, nodeId);
    if (outcome.committed) store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
    store.finishRun(
      runId,
      { status: 'done', reason: 'finished', error: null },
      { cost: 0, inputTokens: 0, outputTokens: 0, commitSha: outcome.commit },
    );
    return runId;
  }

  test('all changes, one run’s, and what is not committed yet', async () => {
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
      displayName: 'child',
      description: 'd',
    });
    const first = await run(nodeId, { 'one.py': '1\n' });
    const second = await run(nodeId, { 'two.py': '2\n' });
    const row = store.getNode(nodeId)!;
    await writeFile(join(row.worktree_path, 'scratch.txt'), 'wip\n', 'utf8');

    const all = await experimentChanges(store, row);
    assert.deepEqual(
      all.files.map((f) => f.path),
      ['one.py', 'two.py'],
      'the child’s own work, not what it inherited',
    );
    assert.deepEqual(all.totals, { files: 2, added: 2, removed: 0 });
    assert.match(all.baseLabel, /inherited code snapshot from master/);
    assert.deepEqual(
      all.uncommitted.map((f) => [f.path, f.untracked]),
      [['scratch.txt', true]],
    );

    const onlySecond = (await runChanges(store, second)).summary;
    assert.deepEqual(
      onlySecond.files.map((f) => f.path),
      ['two.py'],
    );
    assert.equal((await runChanges(store, first)).summary.files[0]?.path, 'one.py');

    // A file opens from the change it is part of...
    assert.match(
      (await changedFilePatch(store, row, { kind: 'run', runId: second }, 'two.py')).patch,
      /\+2/,
    );
    assert.match(
      (await changedFilePatch(store, row, { kind: 'uncommitted' }, 'scratch.txt')).patch,
      /\+wip/,
    );
    // ...and from nowhere else.
    for (const [scope, path] of [
      [{ kind: 'run', runId: second }, 'one.py'],
      [{ kind: 'all' }, 'scratch.txt'],
      [{ kind: 'all' }, '../../etc/passwd'],
      [{ kind: 'all' }, '--output=/tmp/x'],
    ] as const) {
      await assert.rejects(changedFilePatch(store, row, scope, path), { status: 404 });
    }
  });

  test('a run of another experiment is not this one’s', async () => {
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const masterRun = await run(masterNodeId, { 'base.py': 'x\n' });
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'child',
      description: 'd',
    });
    await assert.rejects(
      changedFilePatch(store, store.getNode(nodeId)!, { kind: 'run', runId: masterRun }, 'base.py'),
      { status: 404 },
    );
  });
});
