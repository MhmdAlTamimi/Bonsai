import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { adoptProject, createChildNode } from '../projects.js';
import { git } from '../git/exec.js';
import type { AgentRunner, RunEvent, RunSpec } from '../agent/AgentRunner.js';

/**
 * D37: the repository is the project, the chosen folder is the working scope.
 *
 * The rule is easy to state and easy to implement half of. These tests hold
 * both halves at once: the agent must START in the subdirectory, and git must
 * still see the WHOLE repository -- a run that wrote in the working directory
 * commits at the file's repository-relative path, on the node's branch in the
 * user's own repo, exactly as it would with no subdirectory at all.
 */
class RecordingRunner implements AgentRunner {
  readonly specs: RunSpec[] = [];

  async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.specs.push({ ...spec });
    if (!spec.readOnly && spec.contextPath) await writeFile(spec.contextPath, '# Root run notes\n');
    assert.ok(spec.contextPath?.endsWith('/CONTEXT.md'));
    yield { type: 'session', sessionId: `session-${this.specs.length}` };
    // Writes where it stands, which is the point: the path this lands at is
    // decided entirely by the cwd the pipeline handed it.
    await writeFile(join(spec.cwd, 'written-here.txt'), 'by the agent\n', 'utf8');
    yield { type: 'done', inputTokens: 1, outputTokens: 1, costUsd: 0 };
  }
}

const settle = async (jobs: RunJobs, nodeId: string): Promise<void> => {
  for (let i = 0; i < 400 && jobs.isRunning(nodeId); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('the agent working directory', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;
  let jobs: RunJobs;
  let runner: RecordingRunner;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-workdir-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
    runner = new RecordingRunner();
    jobs = new RunJobs(store, new EventBus(), runner);
  });

  afterEach(async () => {
    await jobs.drain();
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A repository with a subproject in it, and the subproject's own folder. */
  async function repoWithSubproject(): Promise<{ repo: string; inner: string }> {
    const repo = join(root, 'mainproject');
    const inner = join(repo, 'subproject1', 'prompts');
    await mkdir(inner, { recursive: true });
    await git(['init', '--initial-branch=main', '.'], repo);
    await git(['config', 'user.email', 'you@example.com'], repo);
    await git(['config', 'user.name', 'You'], repo);
    await writeFile(join(repo, 'README.md'), '# mainproject\n', 'utf8');
    await writeFile(join(inner, 'existing.md'), 'an existing prompt\n', 'utf8');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'first'], repo);
    return { repo, inner };
  }

  test('a run starts in the chosen folder, and commits against the whole repository', async () => {
    const { repo, inner } = await repoWithSubproject();
    const { projectId, masterNodeId } = await adoptProject(store, {
      path: inner,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'add a prompt',
      description: '',
    });

    jobs.start(nodeId, 'write a new prompt');
    await settle(jobs, nodeId);

    const node = store.getNode(nodeId)!;
    assert.equal(
      runner.specs[0]?.cwd,
      join(node.worktree_path, 'subproject1', 'prompts'),
      'the agent starts in the folder the user chose, inside this node’s worktree',
    );

    // Git saw a change to the repository, at the file's repository-relative
    // path -- not a change to a folder it considers a project of its own.
    const run = store.listRuns(nodeId).at(-1)!;
    assert.equal(run.status, 'done');
    assert.ok(run.commitSha, 'the run committed');
    const listed = await git(
      ['show', '--name-only', '--pretty=format:', run.commitSha],
      node.worktree_path,
    );
    assert.ok(
      listed.includes('subproject1/prompts/written-here.txt'),
      `expected a repository-relative path, got: ${listed}`,
    );

    // The user's own repository and branch are untouched by the run.
    assert.equal((await git(['branch', '--show-current'], repo)).trim(), 'main');
  });

  test('the setup command runs in the working directory, not the worktree root', async () => {
    const { inner } = await repoWithSubproject();
    const { projectId, masterNodeId } = await adoptProject(store, {
      path: inner,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    // Writes a gitignored file naming the directory it ran in, so where it ran
    // is provable rather than inferred.
    store.saveProjectConfiguration(projectId, {
      setupCommand: 'pwd > .where-setup-ran',
    });
    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'set up and run',
      description: '',
    });

    jobs.start(nodeId, 'do the thing');
    await settle(jobs, nodeId);

    const node = store.getNode(nodeId)!;
    const { readFile } = await import('node:fs/promises');
    const where = (
      await readFile(join(node.worktree_path, 'subproject1', 'prompts', '.where-setup-ran'), 'utf8')
    ).trim();
    assert.equal(where, join(node.worktree_path, 'subproject1', 'prompts'));
  });

  test('a project at the repository root is unchanged: the worktree root is the cwd', async () => {
    const { repo } = await repoWithSubproject();
    const { projectId, masterNodeId } = await adoptProject(store, {
      path: repo,
      description: '',
      model: null,
      permissionMode: 'default',
    });
    assert.equal(store.getProject(projectId)!.work_dir, '');

    const { nodeId } = await createChildNode(store, {
      projectId,
      parentId: masterNodeId,
      displayName: 'work at the root',
      description: '',
    });
    jobs.start(nodeId, 'do the thing');
    await settle(jobs, nodeId);

    assert.equal(runner.specs[0]?.cwd, store.getNode(nodeId)!.worktree_path);
  });
});
