import { createAllocatedChild as createChildNode } from '../testing/allocatedChild.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { adoptProject, createProject } from '../projects.js';
import { commitRunOutput } from '../git/commit.js';
import { branchNameFor } from '../git/repo.js';
import { git, gitLine } from '../git/exec.js';
import { runCommand } from '../exec/command.js';
import { writeApplyPatch } from './applyPatch.js';

/**
 * The command that takes an experiment's changes to your own repository.
 *
 * Every test RUNS the command, in a folder standing in for yours, because a
 * string that exists to be pasted into a terminal is only right if it works
 * there.
 */
describe('the apply command', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let patches: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-apply-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    patches = join(root, 'data', 'patches');
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** Commits files in a node the way a run does, notes included. */
  async function commit(nodeId: string, files: Record<string, string>): Promise<void> {
    const node = store.getNode(nodeId)!;
    for (const [path, content] of Object.entries(files))
      await writeFile(join(node.worktree_path, path), content, 'utf8');
    const outcome = await commitRunOutput({
      repoPath: store.getProject(node.project_id)!.repo_path,
      worktreePath: node.worktree_path,
      branchName: node.branch_name ?? branchNameFor(nodeId),
      message: 'work',
      baseCommit: node.base_commit,
    });
    store.recordCommit(nodeId, outcome.branch!, outcome.commit!);
  }

  async function mine(): Promise<string> {
    const folder = join(root, 'mine');
    await git(['init', '--initial-branch=main', folder], root);
    await git(['config', 'user.email', 'a@b.c'], folder);
    await git(['config', 'user.name', 'A'], folder);
    await writeFile(join(folder, 'app.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    await git(['add', '-A'], folder);
    await git(['commit', '-m', 'first'], folder);
    return folder;
  }

  const run = (command: string, cwd: string) => runCommand({ command, cwd, timeoutMs: 30_000 });

  test('applies to your folder uncommitted, without Bonsai’s notes, after your code moved on', async () => {
    const folder = await mine();
    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'try Redis',
      description: '',
    });
    await commit(nodeId, {
      'app.txt': 'ONE\ntwo\nthree\nfour\nfive\n',
      'cache.txt': 'redis\n',
      'CONTEXT.md': '# notes\n',
    });
    // You kept working on a different line after the experiment started.
    await writeFile(join(folder, 'app.txt'), 'one\ntwo\nthree\nfour\nFIVE\n', 'utf8');
    await git(['commit', '-am', 'mine'], folder);
    const head = await gitLine(['rev-parse', 'HEAD'], folder);

    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    assert.deepEqual([patch.files, patch.added, patch.removed], [2, 2, 1]);
    assert.match(patch.path, /try-redis-[0-9a-f]{7}\.patch$/);
    assert.equal(patch.behind, null);

    const result = await run(patch.command, folder);
    assert.equal(result.ok, true, `${patch.command}\n${result.stderr}`);
    assert.equal(await readFile(join(folder, 'app.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour\nFIVE\n');
    assert.equal(await readFile(join(folder, 'cache.txt'), 'utf8'), 'redis\n');
    await assert.rejects(readFile(join(folder, 'CONTEXT.md')), { code: 'ENOENT' });
    // Nothing committed: that is yours to do.
    assert.equal(await gitLine(['rev-parse', 'HEAD'], folder), head);
  });

  test('never overwrites a file you are still editing', async () => {
    const folder = await mine();
    const adopted = await adoptProject(store, {
      path: folder,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId: adopted.projectId,
      parentId: adopted.masterNodeId,
      displayName: 'edit',
      description: '',
    });
    await commit(nodeId, { 'app.txt': 'ONE\ntwo\nthree\nfour\nfive\n' });
    await writeFile(join(folder, 'app.txt'), 'one\ntwo\nmy unsaved edit\nfour\nfive\n', 'utf8');

    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    const result = await run(patch.command, folder);
    assert.equal(result.ok, false);
    assert.equal(
      await readFile(join(folder, 'app.txt'), 'utf8'),
      'one\ntwo\nmy unsaved edit\nfour\nfive\n',
    );
  });

  test('works for a project Bonsai created, and says when the experiment is behind', async () => {
    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    await commit(created.masterNodeId, { 'app.txt': 'base\n' });
    const { nodeId } = await createChildNode(store, {
      projectId: created.projectId,
      parentId: created.masterNodeId,
      displayName: 'child',
      description: '',
    });
    await assert.rejects(writeApplyPatch(store, store.getNode(nodeId)!, patches), {
      status: 409,
    });
    await commit(nodeId, { 'feature.txt': 'feature\n' });
    await commit(created.masterNodeId, { 'app.txt': 'base, improved\n' });

    const patch = await writeApplyPatch(store, store.getNode(nodeId)!, patches);
    assert.deepEqual(patch.behind, { commits: 1, parentName: 'master' });

    // Any clone stands in for "your repository" here.
    const clone = join(root, 'clone');
    await git(['clone', store.getProject(created.projectId)!.repo_path, clone], root);
    const result = await run(patch.command, clone);
    assert.equal(result.ok, true, result.stderr);
    assert.equal(await readFile(join(clone, 'feature.txt'), 'utf8'), 'feature\n');
  });
});
