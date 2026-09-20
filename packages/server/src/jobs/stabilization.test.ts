import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { adoptProject, createProject, createChildNode, deleteNodeTree } from '../projects.js';
import { git, gitLine } from '../git/exec.js';
import type { AgentRunner, RunEvent, RunSpec } from '../agent/AgentRunner.js';
import type { DatabaseSync } from 'node:sqlite';

let root: string;
let db: DatabaseSync;
let store: Store;
let jobs: RunJobs;
let specs: RunSpec[];
let action: (spec: RunSpec) => Promise<void>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bonsai-jobs-safe-'));
  db = openInMemory();
  store = new Store(db, join(root, 'repos'));
  specs = [];
  action = async () => {
    /* No agent edits unless the test requests them. */
  };
  const runner: AgentRunner = {
    async *run(spec): AsyncIterable<RunEvent> {
      specs.push(spec);
      await action(spec);
      yield { type: 'done', inputTokens: 0, outputTokens: 0, costUsd: 0 };
    },
  };
  jobs = new RunJobs(store, new EventBus(), runner);
});
afterEach(async () => {
  await jobs.drain();
  db.close();
  await rm(root, { recursive: true, force: true });
});
async function settled(id: string): Promise<void> {
  for (let i = 0; i < 500 && jobs.isRunning(id); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(jobs.isRunning(id), false, 'run releases its slot');
}
const create = () =>
  createProject(store, {
    name: 'project',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });

test('read-only original checkout never runs setup', async () => {
  const repo = join(root, 'original');
  await mkdir(repo);
  await git(['init', '--initial-branch=main'], repo);
  await writeFile(join(repo, 'keep'), 'original');
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'base'], repo);
  const p = await adoptProject(store, {
    path: repo,
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  store.updateProjectSetup(p.projectId, { setupCommand: 'echo overwritten > keep' });
  jobs.start(p.masterNodeId, 'explain');
  await settled(p.masterNodeId);
  assert.equal(specs[0]?.readOnly, true);
  assert.equal(await readFile(join(repo, 'keep'), 'utf8'), 'original');
  assert.equal(store.getNode(p.masterNodeId)?.setup_ran_at, null);
});

test('setup failure boundary finalizes a run and releases the slot', async () => {
  const p = await create();
  store.updateProjectSetup(p.projectId, { setupCommand: 'rm .git' });
  jobs.start(p.masterNodeId, 'work');
  await settled(p.masterNodeId);
  assert.equal(store.listRuns(p.masterNodeId).at(-1)?.status, 'failed');
  assert.equal(specs.length, 0);
  assert.equal(jobs.activeCount(), 0);
});

test('agent Git drift fails even when it leaves a clean worktree, preserving its commit', async () => {
  const p = await create();
  action = async (spec) => {
    await writeFile(join(spec.cwd, 'agent.txt'), 'preserve');
    await git(['add', '-A'], spec.cwd);
    await git(['commit', '-m', 'unexpected'], spec.cwd);
  };
  const before = store.getNode(p.masterNodeId)!.head_commit;
  jobs.start(p.masterNodeId, 'work');
  await settled(p.masterNodeId);
  const row = store.getNode(p.masterNodeId)!;
  assert.equal(store.listRuns(row.id).at(-1)?.status, 'failed');
  assert.equal(row.head_commit, before);
  assert.notEqual(await gitLine(['rev-parse', 'HEAD'], row.worktree_path), before);
  assert.equal(await readFile(join(row.worktree_path, 'agent.txt'), 'utf8'), 'preserve');
});

test('recovery selects the request, never the later permission answer; legacy falls back to description', async () => {
  const p = await create();
  jobs.start(p.masterNodeId, 'original request');
  await settled(p.masterNodeId);
  const run = store.listRuns(p.masterNodeId).at(-1)!;
  store.appendMessage({
    nodeId: p.masterNodeId,
    runId: run.id,
    role: 'user',
    kind: 'text',
    content: 'Yes, proceed',
  });
  assert.equal(store.lastUserPrompt(p.masterNodeId), 'original request');
  const child = await createChildNode(store, {
    projectId: p.projectId,
    parentId: p.masterNodeId,
    displayName: 'child',
    description: 'legacy task',
  });
  store.appendMessage({
    nodeId: child.nodeId,
    runId: null,
    role: 'user',
    kind: 'text',
    content: 'unattributed answer',
  });
  assert.equal(store.lastUserPrompt(child.nodeId), null);
});

test('failed node allocation rolls back its row without deleting existing files', async () => {
  const p = await create();
  db.prepare('UPDATE node SET head_commit = ? WHERE id = ?').run('missing-object', p.masterNodeId);
  await assert.rejects(
    createChildNode(store, {
      projectId: p.projectId,
      parentId: p.masterNodeId,
      displayName: 'bad',
      description: '',
    }),
  );
  assert.equal(store.listNodes(p.projectId).length, 1);
});

test('deletion rejects a different branch even with the node prefix', async () => {
  const p = await create();
  const child = await createChildNode(store, {
    projectId: p.projectId,
    parentId: p.masterNodeId,
    displayName: 'child',
    description: '',
  });
  const node = store.getNode(child.nodeId)!;
  await git(['switch', '-c', 'node/somebody-else'], node.worktree_path);
  await writeFile(join(node.worktree_path, 'keep'), 'keep');
  await assert.rejects(deleteNodeTree(store, node.id), /changed outside Bonsai/);
  assert.ok(store.getNode(node.id));
  assert.equal(await readFile(join(node.worktree_path, 'keep'), 'utf8'), 'keep');
});

test('creation never takes ownership of a pre-existing empty folder', async () => {
  const existing = join(root, 'project');
  await mkdir(existing);
  const p = await createProject(store, {
    name: 'project',
    location: root,
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  assert.equal(p.path, join(root, 'project-2'));
  assert.ok(await import('node:fs/promises').then(({ stat }) => stat(existing)));
});

test('failed project creation removes its new directory and rows', async () => {
  db.exec(
    "CREATE TRIGGER fail_node BEFORE INSERT ON node BEGIN SELECT RAISE(ABORT, 'allocation failed'); END",
  );
  await assert.rejects(
    createProject(store, {
      name: 'rollback',
      location: root,
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    }),
    /allocation failed/,
  );
  assert.equal(store.listProjects().length, 0);
  await assert.rejects(readFile(join(root, 'rollback')), { code: 'ENOENT' });
});
