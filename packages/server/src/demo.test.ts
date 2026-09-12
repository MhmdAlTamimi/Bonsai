import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from './db/open.js';
import { Store } from './db/store.js';
import { EventBus } from './api/events.js';
import { RunJobs } from './jobs/runNode.js';
import { FakeRunner } from './agent/FakeRunner.js';
import { createChildNode, createProject } from './projects.js';
import { gitLine } from './git/exec.js';
import { currentBranch } from './git/commit.js';

/**
 * THE M5 CHECKPOINT: the demo script from PRD §2, end to end.
 *
 * §2 is the definition of done for V0 -- "anything not required by this script
 * is out of scope by construction" -- so it is worth having as one test that
 * runs the whole thing rather than six that each prove a piece.
 *
 * Real git in a temp directory. The agent is the stand-in, because what this
 * asserts is Bonsai's behaviour around a run, not the model's output: which
 * commit a node branches from, which conversation it inherits, and whether
 * siblings can see each other.
 */
describe('PRD §2 — the demo script', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-demo-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    jobs = new RunJobs(store, new EventBus(), new FakeRunner());
  });

  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  const run = async (nodeId: string, prompt: string): Promise<void> => {
    jobs.start(nodeId, prompt);
    for (let i = 0; i < 400 && jobs.isRunning(nodeId); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(jobs.isRunning(nodeId), false, `run on ${nodeId} never finished`);
  };

  test('runs end to end, with the five nodes the script describes', async () => {
    // ---- 1. Create a project; the agent scaffolds from the description. ----
    const { projectId, masterNodeId } = await createProject(store, {
      name: 'todo-cli',
      description: 'A small Python CLI for managing a todo list.',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const project = store.getProject(projectId)!;

    // D21: a repo, a master branch and a commit exist before anything runs.
    assert.equal(await currentBranch(store.getNode(masterNodeId)!.worktree_path), 'master');
    assert.notEqual(store.getNode(masterNodeId)!.head_commit, null);

    await run(masterNodeId, 'scaffold a Python todo CLI');
    const masterCommit = store.getNode(masterNodeId)!.head_commit!;

    // ---- 2. Branch twice from master, two different approaches. ----
    const a = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'argparse',
      description: 'build the CLI on the stdlib argparse module',
    });
    const b = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'click',
      description: 'build the CLI on the click library',
    });
    assert.equal(store.getNode(a.nodeId)!.base_commit, masterCommit);
    assert.equal(store.getNode(b.nodeId)!.base_commit, masterCommit);

    await run(a.nodeId, 'implement it with argparse');
    await run(b.nodeId, 'implement it with click');
    const aCommit = store.getNode(a.nodeId)!.head_commit!;
    assert.notEqual(aCommit, store.getNode(b.nodeId)!.head_commit);

    // ---- 3. An exploration on one of them: ask a question about the code. ----
    const e = await createChildNode(store, {
      projectId,
      parentId: a.nodeId,
      displayName: 'why argparse?',
      description: 'how does the argument parsing handle subcommands?',
    });
    // §6.4 / D26: no branch, and a worktree detached at the parent's commit.
    assert.equal(await currentBranch(store.getNode(e.nodeId)!.worktree_path), null);
    assert.equal(
      await gitLine(['rev-parse', 'HEAD'], store.getNode(e.nodeId)!.worktree_path),
      aCommit,
    );

    await run(e.nodeId, '? how do subcommands work here');

    // D6/A1: it is an exploration because its run wrote nothing, not because
    // anyone said so at creation.
    assert.equal(store.getNode(e.nodeId)!.head_commit, null);
    assert.equal(store.getNode(e.nodeId)!.branch_name, null);
    // D28: exploration nodes get no CONTEXT.md -- the one it wrote was reverted.
    assert.equal(
      existsSync(join(store.getNode(e.nodeId)!.worktree_path, 'CONTEXT.md')),
      true,
      "argparse's committed CONTEXT.md is inherited and must still be here",
    );

    // ---- 4. Spawn a child from that exploration node. ----
    const f = await createChildNode(store, {
      projectId,
      parentId: e.nodeId,
      displayName: 'add --verbose',
      description: 'add a --verbose flag using the subcommand pattern discussed',
    });
    await run(f.nodeId, 'add the --verbose flag');

    // ---- 5. The child carries the exploration's conversation AND branches
    //         from the exploration's parent commit. ----
    assert.equal(
      store.getNode(f.nodeId)!.base_commit,
      aCommit,
      'CODE: must branch from argparse, skipping the exploration entirely',
    );
    const parents = await gitLine(
      ['rev-list', '--parents', '-n', '1', store.getNode(f.nodeId)!.head_commit!],
      project.repo_path,
    );
    assert.ok(parents.endsWith(aCommit), "the commit's parent is argparse's commit");

    assert.notEqual(
      store.getNode(f.nodeId)!.forked_from_message_seq,
      null,
      "CONTEXT: must have forked the exploration's session",
    );
    assert.notEqual(store.getNode(f.nodeId)!.session_id, store.getNode(e.nodeId)!.session_id);
    assert.notEqual(store.getNode(f.nodeId)!.session_id, null);

    // ---- 6. Five nodes, correct ancestry, siblings isolated. ----
    const nodes = store.treeView(projectId);
    assert.equal(nodes.length, 5);

    const byName = new Map(nodes.map((n) => [n.displayName, n]));
    const parentName = (name: string): string | null => {
      const pid = byName.get(name)!.parentId;
      return pid === null ? null : store.getNode(pid)!.display_name;
    };
    assert.equal(parentName('master'), null);
    assert.equal(parentName('argparse'), 'master');
    assert.equal(parentName('click'), 'master');
    assert.equal(parentName('why argparse?'), 'argparse');
    assert.equal(parentName('add --verbose'), 'why argparse?');

    // Siblings isolated (D1): click's worktree cannot see argparse's work.
    const aFiles = await gitLine(['ls-files'], store.getNode(a.nodeId)!.worktree_path);
    const bFiles = await gitLine(['ls-files'], store.getNode(b.nodeId)!.worktree_path);
    assert.notDeepEqual(aFiles.split('\n').sort(), bFiles.split('\n').sort());
    assert.ok(aFiles.includes('argparse'), 'argparse kept its own work');
    assert.ok(!bFiles.includes('argparse'), 'click cannot see it');

    // And the flags the canvas renders from are what the script implies.
    assert.equal(byName.get('master')!.writable, false, 'frozen: argparse and click committed');
    assert.equal(byName.get('why argparse?')!.writable, false, 'frozen: its child committed');
    assert.equal(byName.get('click')!.writable, true, 'a writable leaf');
    assert.equal(byName.get('why argparse?')!.createsBranch, false, 'conversation only');
    assert.equal(byName.get('add --verbose')!.createsBranch, true);

    /**
     * argparse has a child and is STILL WRITABLE, and this is the case the
     * `writable = creates_branch && isLeaf` formulation got wrong.
     *
     * Its only child is the exploration, which committed nothing, so nothing
     * has branched off argparse's code and nothing downstream can go stale by
     * committing to it again. `add --verbose` is a child of the exploration,
     * not of argparse -- it took argparse's COMMIT as its base without becoming
     * argparse's child, which is the code/conversation split this whole demo
     * exists to show.
     */
    assert.equal(byName.get('argparse')!.isLeaf, false);
    assert.equal(byName.get('argparse')!.writable, true);
  });
});
