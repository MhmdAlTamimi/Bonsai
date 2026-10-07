import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import {
  createProject,
  createChildNode,
  allocateNodeWorktree,
  adoptProject,
  deleteNodeTree,
} from '../projects.js';
import { createLegacyProject } from '../testing/legacyProject.js';
import { createAllocatedChild } from '../testing/allocatedChild.js';
import { commitRunOutput } from '../git/commit.js';
import { branchOf, nodeRef, tipOf } from '../git/refs.js';
import { git, gitLine } from '../git/exec.js';
import { experimentNotes, reviewOf, reviewPatchOf } from '../api/review.js';
import { archiveFolder, storageUse } from '../archive.js';
import { EventBus } from '../api/events.js';
import { RunJobs } from './runNode.js';
import { ExecutionPool } from './executionPool.js';
import { FakeRunner } from '../agent/FakeRunner.js';
import type { RunEvent, RunSpec } from '../agent/AgentRunner.js';
import {
  localFilesDir,
  recoverWorkspaceSwitches,
  validateRebuildPaths,
  withProjectWorkspace,
} from './projectWorkspace.js';
import { migrateProjectWorkspace, workspaceMigrationView } from '../storage/workspaceMigration.js';
import { Settings } from '../settings.js';
import { makeBackup } from '../storage/backup.js';
import { relocateManagedStorage } from '../storage/relocate.js';
import { silentLogger } from '../log.js';
import { restoreWorkspace } from '../storage/workspaceRecovery.js';
import { randomBytes } from 'node:crypto';
import { recoverRunSaves } from '../git/saveRecovery.js';
import { expectedGitState } from '../git/ownership.js';
import { lostExperiments, importLostExperiment } from '../storage/orphans.js';

let root: string;
let db: ReturnType<typeof openDatabase>;
let store: Store;
let jobs: RunJobs | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bonsai-shared-'));
  db = openDatabase(join(root, 'data'));
  store = new Store(db, join(root, 'data', 'repos'));
});
afterEach(async () => {
  await jobs?.drain();
  jobs = undefined;
  db.close();
  await rm(root, { recursive: true, force: true });
});
const create = (name = 'shared') =>
  createProject(store, { name, description: '', model: null, permissionMode: 'acceptEdits' });
const child = (projectId: string, parentId: string, displayName: string) =>
  createChildNode(store, { projectId, parentId, displayName, description: '' });
async function save(nodeId: string, files: Record<string, string>): Promise<void> {
  const node = store.getNode(nodeId)!;
  await allocateNodeWorktree(store, node);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(node.worktree_path, path, '..'), { recursive: true });
    await writeFile(join(node.worktree_path, path), content);
  }
  const outcome = await commitRunOutput({
    repoPath: store.getProject(node.project_id)!.repo_path,
    worktreePath: node.worktree_path,
    branchName: branchOf(node),
    ref: nodeRef(node.project_id, node.id),
    message: 'fixture',
  });
  if (outcome.committed) store.recordCommit(node.id, outcome.branch!, outcome.commit!);
}
async function settle(nodeId: string): Promise<void> {
  for (let i = 0; jobs!.isRunning(nodeId) && i < 1000; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(jobs!.isRunning(nodeId), false, 'run finalized');
}

test('six experiments use one checkout and preserve independent source versions and pinned child bases', async () => {
  const project = await create();
  await save(project.masterNodeId, {
    'source.txt': 'original',
    '.gitignore': 'node_modules/\nresults/\n',
  });
  const nodes = [];
  for (let i = 0; i < 6; i++)
    nodes.push(await child(project.projectId, project.masterNodeId, `experiment ${i}`));
  const path = store.workspaces.get(project.projectId)!.path;
  for (let i = 0; i < nodes.length; i++) {
    await save(nodes[i]!.nodeId, { 'source.txt': `version ${i}` });
    assert.equal(store.getNode(nodes[i]!.nodeId)!.worktree_path, path);
    assert.equal(
      store.listNodes(project.projectId).filter((node) => node.worktree_allocated).length,
      1,
    );
  }
  await allocateNodeWorktree(store, store.getNode(nodes[0]!.nodeId)!);
  assert.equal(await readFile(join(path, 'source.txt'), 'utf8'), 'version 0');
  assert.equal((await storageUse(store)).folders, 1);
  const registered = await git(
    ['worktree', 'list', '--porcelain'],
    store.getProject(project.projectId)!.repo_path,
  );
  assert.equal(
    registered.split('\n').filter((line) => line.startsWith('worktree ')).length,
    2,
    'bare repository plus one checkout',
  );
  assert.equal(store.getNode(nodes[1]!.nodeId)!.base_commit, nodes[1]!.baseCommit);
});

test('unknown ignored data is node-scoped; explicitly regeneratable environments are removed on switches', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'node_modules/\nresults/\n.env\n' });
  store.saveProjectConfiguration(project.projectId, { rebuildPaths: ['node_modules'] });
  const a = await child(project.projectId, project.masterNodeId, 'A');
  const b = await child(project.projectId, project.masterNodeId, 'B');
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  const path = store.workspaces.get(project.projectId)!.path;
  await mkdir(join(path, 'node_modules'), { recursive: true });
  await writeFile(join(path, 'node_modules', 'a.txt'), 'A dependency');
  await mkdir(join(path, 'results'), { recursive: true });
  await writeFile(join(path, 'results', 'answer.txt'), 'valuable A result');
  await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
  assert.equal(existsSync(join(path, 'node_modules')), false);
  assert.equal(existsSync(join(path, 'results')), false);
  assert.equal(
    await readFile(
      join(localFilesDir(store, project.projectId, a.nodeId), 'files', 'results', 'answer.txt'),
      'utf8',
    ),
    'valuable A result',
  );
  await mkdir(join(path, 'results'), { recursive: true });
  await writeFile(join(path, 'results', 'answer.txt'), 'valuable B result');
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  assert.equal(await readFile(join(path, 'results', 'answer.txt'), 'utf8'), 'valuable A result');
  await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
  assert.equal(await readFile(join(path, 'results', 'answer.txt'), 'utf8'), 'valuable B result');
  assert.ok((await storageUse(store)).localFileBytes! > 0);
});

test('dirty, staged, untracked, held, drifted, and missing workspaces block switching without loss', async () => {
  const project = await create();
  await save(project.masterNodeId, { 'source.txt': 'original' });
  const b = await child(project.projectId, project.masterNodeId, 'B');
  const path = store.workspaces.get(project.projectId)!.path;
  await writeFile(join(path, 'source.txt'), 'unfinished');
  await git(['add', 'source.txt'], path);
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!), /unfinished/);
  assert.equal(await readFile(join(path, 'source.txt'), 'utf8'), 'unfinished');
  await git(['reset', '--hard'], path);
  await writeFile(join(path, 'scratch.txt'), 'untracked');
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!), /unfinished/);
  await rm(join(path, 'scratch.txt'));
  store.workspaces.hold(project.projectId, true);
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!), /Keep active/);
  store.workspaces.hold(project.projectId, false);
  await git(['checkout', '--detach', 'HEAD~1'], path);
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!), /outside Bonsai/);
  await git(['checkout', 'master'], path);
  await rm(path, { recursive: true });
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!));
  assert.equal(existsSync(path), false);
});

test('inactive review and notes use saved commits, not the active experiment', async () => {
  const project = await create();
  const a = await child(project.projectId, project.masterNodeId, 'A');
  const b = await child(project.projectId, project.masterNodeId, 'B');
  const notes = store.getProject(project.projectId)!.notes_path!;
  await save(a.nodeId, { 'a.txt': 'A', [notes]: '# A notes' });
  await save(b.nodeId, { 'b.txt': 'B', [notes]: '# B notes' });
  const view = await reviewOf(store, store.getNode(a.nodeId)!);
  assert.ok(view.files.some((file) => file.path === 'a.txt'));
  assert.ok(!view.files.some((file) => file.path === 'b.txt'));
  assert.equal((await experimentNotes(store, store.getNode(a.nodeId)!)).contextMd, '# A notes');
  const file = await reviewPatchOf(store, store.getNode(a.nodeId)!, 'a.txt', true);
  assert.equal(file.content, 'A');
});

test('freeing working space preserves ignored outputs and can restore a never-committing node', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'result.txt\n' });
  const a = await child(project.projectId, project.masterNodeId, 'A');
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  const path = store.workspaces.get(project.projectId)!.path;
  await writeFile(join(path, 'result.txt'), 'valuable');
  await archiveFolder(store, store.getNode(a.nodeId)!, false);
  assert.equal(existsSync(path), false);
  assert.equal(store.workspaces.get(project.projectId)!.active_node_id, null);
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  assert.equal(await readFile(join(path, 'result.txt'), 'utf8'), 'valuable');
  assert.equal(store.getNode(a.nodeId)!.head_commit, null);
});

test('deleting an inactive experiment leaves the active checkout untouched; deleting active code leaves siblings recoverable', async () => {
  const project = await create();
  const a = await child(project.projectId, project.masterNodeId, 'A');
  const b = await child(project.projectId, project.masterNodeId, 'B');
  await save(a.nodeId, { 'a.txt': 'A' });
  await save(b.nodeId, { 'b.txt': 'B' });
  const path = store.workspaces.get(project.projectId)!.path;
  await deleteNodeTree(store, a.nodeId);
  assert.equal(await readFile(join(path, 'b.txt'), 'utf8'), 'B');
  await deleteNodeTree(store, b.nodeId);
  assert.equal(store.workspaces.get(project.projectId)!.active_node_id, null);
  await allocateNodeWorktree(store, store.getNode(project.masterNodeId)!);
  assert.equal(
    await gitLine(['rev-parse', 'HEAD'], path),
    tipOf(store.getNode(project.masterNodeId)!),
  );
});

test('switch replay after an interrupted checkout preserves outputs and assigns the exact target', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'result.txt\n' });
  const b = await child(project.projectId, project.masterNodeId, 'B');
  const path = store.workspaces.get(project.projectId)!.path;
  await writeFile(join(path, 'result.txt'), 'result');
  // Inject a Git checkout failure after durable preservation: index lock blocks checkout.
  const lock = await gitLine(
    ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
    path,
  );
  await writeFile(lock, 'fixture lock');
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!));
  assert.ok(store.workspaces.get(project.projectId)!.switch_json);
  assert.equal(
    await readFile(
      join(localFilesDir(store, project.projectId, project.masterNodeId), 'files', 'result.txt'),
      'utf8',
    ),
    'result',
  );
  await rm(lock);
  db.close();
  db = openDatabase(join(root, 'data'));
  store = new Store(db, join(root, 'data', 'repos'));
  await recoverWorkspaceSwitches(store);
  assert.equal(store.workspaces.get(project.projectId)!.active_node_id, b.nodeId);
  assert.equal(store.workspaces.get(project.projectId)!.switch_json, null);
  await allocateNodeWorktree(store, store.getNode(project.masterNodeId)!);
  assert.equal(await readFile(join(path, 'result.txt'), 'utf8'), 'result');
});

test('explicit recovery preserves unexpected commits, staged content and ignored bytes before restoring the previous experiment', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'result.txt\ncache/\n' });
  const b = await child(project.projectId, project.masterNodeId, 'B');
  const path = store.workspaces.get(project.projectId)!.path;
  await writeFile(join(path, 'result.txt'), 'original result');
  const lock = await gitLine(
    ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
    path,
  );
  await writeFile(lock, 'fixture');
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!));
  await rm(lock);
  await writeFile(join(path, 'external.txt'), 'external code');
  await git(['add', 'external.txt'], path);
  await git(['commit', '-m', 'external change'], path);
  await writeFile(join(path, 'staged.txt'), 'staged-only');
  await git(['add', 'staged.txt'], path);
  await writeFile(join(path, 'staged.txt'), 'working version');
  await writeFile(join(path, 'result.txt'), 'external ignored result');
  await mkdir(join(path, 'cache', '.git'), { recursive: true });
  await writeFile(join(path, 'cache', '.git', 'valuable-objects'), 'nested Git bytes');
  await assert.rejects(recoverWorkspaceSwitches(store));
  const preserved = await restoreWorkspace(store, project.projectId, join(root, 'recovery'));
  assert.equal(
    await readFile(join(`${preserved}-working-files`, 'staged.txt'), 'utf8'),
    'working version',
  );
  assert.equal(
    await readFile(join(`${preserved}-working-files`, 'result.txt'), 'utf8'),
    'external ignored result',
  );
  assert.equal(await readFile(join(path, 'result.txt'), 'utf8'), 'original result');
  assert.equal(
    await readFile(join(`${preserved}-working-files`, 'cache', '.git', 'valuable-objects'), 'utf8'),
    'nested Git bytes',
  );
  assert.equal(existsSync(join(path, 'external.txt')), false);
  assert.equal(store.workspaces.get(project.projectId)!.active_node_id, project.masterNodeId);
  assert.equal(store.workspaces.get(project.projectId)!.switch_json, null);
  const protectedRefs = await git(
    ['for-each-ref', '--format=%(refname)', 'refs/heads/preserved-*'],
    preserved,
  );
  assert.ok(protectedRefs.trim());
  await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
});

test('an interrupted legacy conversion can resume after restart without losing preserved files', async () => {
  const project = await createLegacyProject(store, {
    name: 'legacy',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  await save(project.masterNodeId, { '.gitignore': 'result.txt\n' });
  const a = await createAllocatedChild(store, {
    projectId: project.projectId,
    parentId: project.masterNodeId,
    displayName: 'A',
    description: '',
  });
  const old = store.getNode(a.nodeId)!.worktree_path;
  await writeFile(join(old, 'result.txt'), 'keep');
  const view = await workspaceMigrationView(store, project.projectId);
  // Stop after old node data was safely preserved/removed, before root checkout conversion.
  const rootPath = store.getNode(project.masterNodeId)!.worktree_path;
  const lock = await gitLine(
    ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
    rootPath,
  );
  await writeFile(lock, 'fixture');
  await assert.rejects(migrateProjectWorkspace(store, project.projectId, view.version));
  assert.ok(store.metadata(`workspace_migration:${project.projectId}`));
  await rm(lock);
  db.close();
  db = openDatabase(join(root, 'data'));
  store = new Store(db, join(root, 'data', 'repos'));
  const retry = await workspaceMigrationView(store, project.projectId);
  await migrateProjectWorkspace(store, project.projectId, retry.version);
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  assert.equal(
    await readFile(join(store.workspaces.get(project.projectId)!.path, 'result.txt'), 'utf8'),
    'keep',
  );
});

test('a fresh adopted project uses its managed shared checkout without switching the user’s branch', async () => {
  const repo = join(root, 'external');
  await mkdir(repo);
  await git(['init', '--initial-branch=main'], repo);
  await writeFile(join(repo, 'source.txt'), 'external');
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'base'], repo);
  const original = await gitLine(['rev-parse', 'HEAD'], repo);
  const project = await adoptProject(store, {
    path: repo,
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  const a = await child(project.projectId, project.masterNodeId, 'A');
  await save(a.nodeId, { 'source.txt': 'experiment' });
  assert.equal(await readFile(join(repo, 'source.txt'), 'utf8'), 'external');
  assert.equal(await gitLine(['branch', '--show-current'], repo), 'main');
  assert.equal(await gitLine(['rev-parse', 'HEAD'], repo), original);
});

test('copy-in changes stay with their experiment, while fresh children receive the saved copy-in baseline', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': '.env\n' });
  const path = store.workspaces.get(project.projectId)!.path;
  await writeFile(join(path, '.env'), 'initial');
  store.saveProjectConfiguration(project.projectId, { copyFiles: ['.env'] });
  const a = await child(project.projectId, project.masterNodeId, 'A');
  const b = await child(project.projectId, project.masterNodeId, 'B');
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'initial');
  await writeFile(join(path, '.env'), 'A changes');
  await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'initial');
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'A changes');
});

test('legacy conversion reclaims checkouts and declared dependencies while preserving code and unknown outputs', async () => {
  const project = await createLegacyProject(store, {
    name: 'legacy',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  await save(project.masterNodeId, {
    '.gitignore': 'node_modules/\nresult.txt\n',
    'source.txt': 'base',
  });
  const a = await createAllocatedChild(store, {
    projectId: project.projectId,
    parentId: project.masterNodeId,
    displayName: 'A',
    description: '',
  });
  await save(a.nodeId, { 'source.txt': 'A' });
  const old = store.getNode(a.nodeId)!.worktree_path;
  await mkdir(join(old, 'node_modules'));
  await writeFile(join(old, 'node_modules', 'package.txt'), 'dependency');
  await writeFile(join(old, 'result.txt'), 'valuable result');
  store.saveProjectConfiguration(project.projectId, { rebuildPaths: ['node_modules'] });
  const preview = await workspaceMigrationView(store, project.projectId);
  assert.deepEqual(preview.blocked, []);
  await migrateProjectWorkspace(store, project.projectId, preview.version);
  assert.equal(existsSync(old), false);
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  const path = store.workspaces.get(project.projectId)!.path;
  assert.equal(await readFile(join(path, 'source.txt'), 'utf8'), 'A');
  assert.equal(await readFile(join(path, 'result.txt'), 'utf8'), 'valuable result');
  assert.equal(existsSync(join(path, 'node_modules')), false);
});

test('dirty legacy conversion is refused without deleting any folder', async () => {
  const project = await createLegacyProject(store, {
    name: 'legacy',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  const path = store.getNode(project.masterNodeId)!.worktree_path;
  await writeFile(join(path, 'unfinished.txt'), 'keep');
  const preview = await workspaceMigrationView(store, project.projectId);
  assert.ok(preview.blocked.length);
  await assert.rejects(migrateProjectWorkspace(store, project.projectId, preview.version));
  assert.equal(await readFile(join(path, 'unfinished.txt'), 'utf8'), 'keep');
  assert.equal(store.workspaces.get(project.projectId), undefined);
});

test('workspace lock rejects concurrent callers, then releases after a failure', async () => {
  const project = await create();
  let release!: () => void;
  const held = withProjectWorkspace(
    store,
    project.projectId,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  for (let i = 0; !release && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(
    withProjectWorkspace(store, project.projectId, () => Promise.resolve()),
    /in use/,
  );
  release();
  await held;
  await assert.rejects(
    withProjectWorkspace(store, project.projectId, () => Promise.reject(new Error('fixture'))),
    /fixture/,
  );
  await withProjectWorkspace(store, project.projectId, () => Promise.resolve());
});

test('regeneratable paths reject escapes, Git metadata, and patterns; symlink parents cannot delete outside files', async () => {
  for (const path of [
    '../data',
    '/tmp',
    'C:\\data',
    '.git',
    '.Git/objects',
    '**/cache',
    '.',
    'a/../b',
  ])
    assert.throws(() => validateRebuildPaths([path]));
  if (process.platform === 'win32') return;
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'outside\n' });
  const path = store.workspaces.get(project.projectId)!.path;
  const outside = join(root, 'valuable');
  await mkdir(outside);
  await writeFile(join(outside, 'data.txt'), 'keep');
  await symlink(outside, join(path, 'outside'));
  store.saveProjectConfiguration(project.projectId, { rebuildPaths: ['outside'] });
  const b = await child(project.projectId, project.masterNodeId, 'B');
  await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
  assert.equal(await readFile(join(outside, 'data.txt'), 'utf8'), 'keep');
});

class HeldRunner extends FakeRunner {
  readonly started: string[] = [];
  readonly specs: RunSpec[] = [];
  readonly releases = new Map<string, () => void>();
  override async *run(spec: RunSpec): AsyncIterable<RunEvent> {
    this.started.push(spec.prompt);
    this.specs.push(spec);
    await new Promise<void>((resolve) => {
      this.releases.set(spec.prompt, resolve);
      spec.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    if (spec.signal.aborted) return;
    yield { type: 'session', sessionId: spec.resumeSessionId ?? `session-${spec.prompt}` };
    yield { type: 'done', costUsd: 0, inputTokens: 0, outputTokens: 0 };
  }
}

test('same-project runs serialize without consuming a waiting global slot; another project can run', async () => {
  const one = await create('one');
  const two = await create('two');
  const a = await child(one.projectId, one.masterNodeId, 'A');
  const b = await child(one.projectId, one.masterNodeId, 'B');
  const c = await child(two.projectId, two.masterNodeId, 'C');
  const runner = new HeldRunner();
  const pool = new ExecutionPool(() => 2);
  jobs = new RunJobs(store, new EventBus(), runner, undefined, silentLogger, undefined, pool);
  jobs.start(a.nodeId, 'A');
  jobs.start(b.nodeId, 'B');
  jobs.start(c.nodeId, 'C');
  for (let i = 0; runner.started.length < 2 && i < 400; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(runner.started.sort(), ['A', 'C']);
  assert.ok(jobs.queuePosition(b.nodeId));
  assert.match(jobs.queueReason(b.nodeId)!, /workspace/);
  await assert.rejects(
    jobs.whileIdle(b.nodeId, () => Promise.resolve()),
    /busy/,
  );
  runner.releases.get('A')!();
  await settle(a.nodeId);
  for (let i = 0; !runner.started.includes('B') && i < 400; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(runner.started.includes('B'));
  runner.releases.get('B')!();
  runner.releases.get('C')!();
  await settle(b.nodeId);
  await settle(c.nodeId);
  assert.equal(store.listRuns(b.nodeId).at(-1)!.status, 'done');
});

test('setup runs again after switching, not for every message, and sees only the selected code', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'environment.txt\n', 'version.txt': 'base' });
  const a = await child(project.projectId, project.masterNodeId, 'A');
  const b = await child(project.projectId, project.masterNodeId, 'B');
  await save(a.nodeId, { 'version.txt': 'A' });
  await save(b.nodeId, { 'version.txt': 'B' });
  store.saveProjectConfiguration(project.projectId, {
    setupCommand:
      "node -e \"require('fs').writeFileSync('environment.txt', require('fs').readFileSync('version.txt'))\"",
    rebuildPaths: ['environment.txt'],
  });
  const runner = new HeldRunner();
  jobs = new RunJobs(store, new EventBus(), runner);
  const run = async (id: string, prompt: string, expected: string) => {
    jobs!.start(id, prompt);
    for (let i = 0; !runner.releases.has(prompt) && i < 400; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const path = store.workspaces.get(project.projectId)!.path;
    assert.equal(await readFile(join(path, 'environment.txt'), 'utf8'), expected);
    runner.releases.get(prompt)!();
    await settle(id);
  };
  await run(a.nodeId, 'A1', 'A');
  await run(a.nodeId, 'A2', 'A');
  await run(b.nodeId, 'B1', 'B');
  await run(a.nodeId, 'A3', 'A');
  const messages = store
    .listMessages(a.nodeId, 0)
    .filter(
      (message) =>
        typeof message.content === 'string' && message.content.startsWith('Setting up this node:'),
    );
  assert.equal(messages.length, 2);
  assert.equal(runner.specs[1]!.resumeSessionId, 'session-A1');
  assert.equal(runner.specs[3]!.resumeSessionId, 'session-A1');
  assert.equal(runner.specs[2]!.resumeSessionId, null);
  assert.equal(new Set(runner.specs.map((spec) => spec.cwd)).size, 1);
});

test('a held workspace queues another experiment, and cancelling it never activates its code', async () => {
  const project = await create();
  const a = await child(project.projectId, project.masterNodeId, 'A');
  const b = await child(project.projectId, project.masterNodeId, 'B');
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  store.workspaces.hold(project.projectId, true);
  const runner = new HeldRunner();
  jobs = new RunJobs(store, new EventBus(), runner);
  jobs.start(b.nodeId, 'B');
  assert.match(jobs.queueReason(b.nodeId)!, /Keep active/);
  jobs.cancel(b.nodeId);
  await settle(b.nodeId);
  assert.deepEqual(runner.started, []);
  assert.equal(store.workspaces.get(project.projectId)!.active_node_id, a.nodeId);
  store.workspaces.hold(project.projectId, false);
  jobs.pool.refresh();
  jobs.start(b.nodeId, 'B2');
  for (let i = 0; !runner.releases.has('B2') && i < 400; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(runner.started, ['B2']);
  runner.releases.get('B2')!();
  await settle(b.nodeId);
});

test('unfinished run saves block switching and a stale generation cannot move the checkout', async () => {
  const project = await create();
  const b = await child(project.projectId, project.masterNodeId, 'B');
  const node = store.getNode(project.masterNodeId)!;
  const workspace = store.workspaces.get(project.projectId)!;
  const run = { id: 'pending-fixture' };
  store.createRun(run.id, node.id);
  store.saves.prepare({
    runId: run.id,
    nodeId: node.id,
    projectId: project.projectId,
    repoPath: store.getProject(project.projectId)!.repo_path,
    worktreePath: workspace.path,
    workspaceGeneration: workspace.generation + 1,
    before: await expectedGitState(store.getProject(project.projectId)!.repo_path, node),
    after: tipOf(node)!,
    totals: { cost: 0, inputTokens: 0, outputTokens: 0 },
    node: {
      status: 'ready',
      commit: { branch: nodeRef(project.projectId, node.id), head: tipOf(node)! },
    },
  });
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!), /save/);
  assert.equal(await recoverRunSaves(store, silentLogger), 0);
  assert.equal(store.workspaces.get(project.projectId)!.active_node_id, node.id);
  assert.equal(store.saves.pending().length, 1);
});

test('ignored files with literal brackets and spaces preserve their exact names', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': '*.log\n' });
  const b = await child(project.projectId, project.masterNodeId, 'B');
  const path = store.workspaces.get(project.projectId)!.path;
  await writeFile(join(path, ' result[1].log'), 'valuable output');
  await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
  assert.equal(existsSync(join(path, ' result[1].log')), false);
  await allocateNodeWorktree(store, store.getNode(project.masterNodeId)!);
  assert.equal(await readFile(join(path, ' result[1].log'), 'utf8'), 'valuable output');
});

test('shared orphan recovery preserves staged and ignored data without adding a live checkout', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'output.txt\n' });
  const id = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const folder = join(store.projectScratchDir(project.projectId), 'worktrees', id);
  const repo = store.getProject(project.projectId)!.repo_path;
  const tip = tipOf(store.getNode(project.masterNodeId)!)!;
  await git(['worktree', 'add', '--detach', folder, tip], repo);
  await git(['update-ref', nodeRef(project.projectId, id), tip], repo);
  await writeFile(join(folder, 'output.txt'), 'orphan output');
  await writeFile(join(folder, 'staged.txt'), 'staged');
  await git(['add', 'staged.txt'], folder);
  const found = (await lostExperiments(store, project.projectId)).find((item) => item.id === id)!;
  const recovered = await importLostExperiment(
    store,
    project.projectId,
    id,
    found.version,
    join(root, 'recovery'),
  );
  assert.equal(store.getNode(id)!.worktree_allocated, 0);
  assert.equal(existsSync(folder), false);
  assert.equal(
    await gitLine(['show', 'preserved-staged:staged.txt'], recovered.preservedPath),
    'staged',
  );
  await allocateNodeWorktree(store, store.getNode(id)!);
  assert.equal(
    await readFile(join(store.workspaces.get(project.projectId)!.path, 'output.txt'), 'utf8'),
    'orphan output',
  );
  assert.equal(
    store.listNodes(project.projectId).filter((node) => node.worktree_allocated).length,
    1,
  );
});

test('submodule versions and removed gitlinks switch cleanly without carrying another node’s code', async () => {
  const module = join(root, 'module');
  await mkdir(module);
  await git(['init', '--initial-branch=main'], module);
  await writeFile(join(module, 'source.txt'), 'one');
  await git(['add', '-A'], module);
  await git(['commit', '-m', 'one'], module);
  const one = await gitLine(['rev-parse', 'HEAD'], module);
  await writeFile(join(module, 'source.txt'), 'two');
  await git(['commit', '-am', 'two'], module);
  const project = await create();
  const path = store.workspaces.get(project.projectId)!.path;
  await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'lib'], path);
  await git(['checkout', one], join(path, 'lib'));
  await save(project.masterNodeId, {});
  const a = await child(project.projectId, project.masterNodeId, 'one');
  await git(['checkout', 'main'], join(path, 'lib'));
  await save(project.masterNodeId, {});
  const b = await child(project.projectId, project.masterNodeId, 'two');
  await git(['rm', '-f', 'lib'], path);
  await save(project.masterNodeId, {});
  const old = process.env['GIT_ALLOW_PROTOCOL'];
  process.env['GIT_ALLOW_PROTOCOL'] = 'file';
  try {
    await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
    assert.equal(await readFile(join(path, 'lib', 'source.txt'), 'utf8'), 'one');
    await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
    assert.equal(await readFile(join(path, 'lib', 'source.txt'), 'utf8'), 'two');
    await allocateNodeWorktree(store, store.getNode(project.masterNodeId)!);
    assert.equal(existsSync(join(path, 'lib', 'source.txt')), false);
    assert.equal(await gitLine(['status', '--porcelain'], path), '');
    await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
    assert.equal(await readFile(join(path, 'lib', 'source.txt'), 'utf8'), 'one');
  } finally {
    if (old === undefined) delete process.env['GIT_ALLOW_PROTOCOL'];
    else process.env['GIT_ALLOW_PROTOCOL'] = old;
  }
});

test('six-experiment disk baseline shrinks to one source/environment while retained outputs are counted', async (t) => {
  const project = await createLegacyProject(store, {
    name: 'disk baseline',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
  const master = store.getNode(project.masterNodeId)!;
  await writeFile(join(master.worktree_path, 'source.bin'), randomBytes(1024 * 1024));
  await save(master.id, { '.gitignore': 'node_modules/\noutput.bin\n' });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const node = await createAllocatedChild(store, {
      projectId: project.projectId,
      parentId: master.id,
      displayName: `experiment ${i}`,
      description: '',
    });
    ids.push(node.nodeId);
    const path = store.getNode(node.nodeId)!.worktree_path;
    await mkdir(join(path, 'node_modules'));
    await writeFile(join(path, 'node_modules', 'environment.bin'), randomBytes(4 * 1024 * 1024));
    await writeFile(join(path, 'output.bin'), randomBytes(128 * 1024));
  }
  const before = await storageUse(store);
  store.saveProjectConfiguration(project.projectId, { rebuildPaths: ['node_modules'] });
  const preview = await workspaceMigrationView(store, project.projectId);
  const started = performance.now();
  await migrateProjectWorkspace(store, project.projectId, preview.version);
  const migrationMs = performance.now() - started;
  await allocateNodeWorktree(store, store.getNode(ids[0]!)!);
  const path = store.workspaces.get(project.projectId)!.path;
  await mkdir(join(path, 'node_modules'));
  await writeFile(join(path, 'node_modules', 'environment.bin'), randomBytes(4 * 1024 * 1024));
  const after = await storageUse(store);
  assert.equal(after.folders, 1);
  assert.ok(after.bytes + (after.localFileBytes ?? 0) < before.bytes / 4);
  assert.ok((after.localFileBytes ?? 0) > 5 * 128 * 1024);
  t.diagnostic(
    JSON.stringify({
      beforeWorkingBytes: before.bytes,
      afterWorkingBytes: after.bytes,
      retainedOutputBytes: after.localFileBytes,
      sharedGitBytes: after.systemBytes?.git,
      migrationMs,
    }),
  );
});

test('index changes after durable preservation block recovery without clearing new staged work', async () => {
  const project = await create();
  const b = await child(project.projectId, project.masterNodeId, 'B');
  const path = store.workspaces.get(project.projectId)!.path;
  const lock = await gitLine(
    ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
    path,
  );
  await writeFile(lock, 'fixture');
  await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!));
  await rm(lock);
  await writeFile(join(path, 'outside.txt'), 'keep staged work');
  const original = store.setMetadata.bind(store);
  store.setMetadata = (key, value) => {
    original(key, value);
    if (
      key === `workspace_recovery:${project.projectId}` &&
      value &&
      (JSON.parse(value) as { stage: string }).stage === 'preserved'
    )
      throw new Error('fixture crash');
  };
  await assert.rejects(
    restoreWorkspace(store, project.projectId, join(root, 'recovery')),
    /fixture crash/,
  );
  store.setMetadata = original;
  await git(['add', 'outside.txt'], path);
  const index = await git(['ls-files', '--stage'], path);
  await assert.rejects(
    restoreWorkspace(store, project.projectId, join(root, 'recovery')),
    /changed after preservation/,
  );
  assert.equal(await git(['ls-files', '--stage'], path), index);
  assert.equal(await readFile(join(path, 'outside.txt'), 'utf8'), 'keep staged work');
});

for (const stage of ['preserved', 'checkout', 'restore', 'complete'] as const) {
  test(`explicit workspace recovery resumes after interruption at ${stage}`, async () => {
    const project = await create();
    await save(project.masterNodeId, { '.gitignore': 'result.txt\n' });
    const b = await child(project.projectId, project.masterNodeId, 'B');
    const path = store.workspaces.get(project.projectId)!.path;
    await writeFile(join(path, 'result.txt'), 'original output');
    const lock = await gitLine(
      ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'],
      path,
    );
    await writeFile(lock, 'fixture');
    await assert.rejects(allocateNodeWorktree(store, store.getNode(b.nodeId)!));
    await rm(lock);
    await writeFile(join(path, 'external.txt'), 'preserve this');
    const original = store.setMetadata.bind(store);
    store.setMetadata = (key, value) => {
      if (
        key === `workspace_recovery:${project.projectId}` &&
        stage === 'complete' &&
        value === null
      )
        throw new Error('fixture crash');
      original(key, value);
      if (
        key === `workspace_recovery:${project.projectId}` &&
        value &&
        (JSON.parse(value) as { stage: string }).stage === stage
      )
        throw new Error('fixture crash');
    };
    await assert.rejects(
      restoreWorkspace(store, project.projectId, join(root, 'recovery')),
      /fixture crash/,
    );
    assert.throws(
      () => store.saveProjectConfiguration(project.projectId, { rebuildPaths: ['result.txt'] }),
      /recovery/,
    );
    db.close();
    db = openDatabase(join(root, 'data'));
    store = new Store(db, join(root, 'data', 'repos'));
    const preserved = await restoreWorkspace(store, project.projectId, join(root, 'recovery'));
    assert.equal(
      await readFile(join(`${preserved}-working-files`, 'external.txt'), 'utf8'),
      'preserve this',
    );
    assert.equal(await readFile(join(path, 'result.txt'), 'utf8'), 'original output');
    assert.equal(existsSync(join(path, 'external.txt')), false);
    assert.equal(store.workspaces.get(project.projectId)!.active_node_id, project.masterNodeId);
    assert.equal(store.metadata(`workspace_recovery:${project.projectId}`), null);
    await allocateNodeWorktree(store, store.getNode(b.nodeId)!);
  });
}

test('a verified backup restores shared ownership and inactive outputs after original storage is deleted', async () => {
  const project = await create();
  await save(project.masterNodeId, { '.gitignore': 'result.txt\n' });
  const a = await child(project.projectId, project.masterNodeId, 'A');
  const b = await child(project.projectId, project.masterNodeId, 'B');
  await save(a.nodeId, { 'a.txt': 'A' });
  await writeFile(join(store.workspaces.get(project.projectId)!.path, 'result.txt'), 'A result');
  await save(b.nodeId, { 'b.txt': 'B' });
  const settings = new Settings({
    dataDir: join(root, 'data'),
    reposRoot: join(root, 'data', 'repos'),
    port: 0,
    defaultModel: null,
    defaultPermissionMode: 'acceptEdits',
  });
  const backup = await makeBackup(store, settings);
  const restored = join(root, 'restored');
  const { rename } = await import('node:fs/promises');
  await rename(backup.path, restored);
  db.close();
  await rm(join(root, 'data'), { recursive: true });
  db = openDatabase(restored);
  store = new Store(db, join(restored, 'repos'));
  const errors: unknown[] = [];
  await relocateManagedStorage(store, restored, {
    ...silentLogger,
    warn: (_event, details) => {
      errors.push(details);
    },
  });
  assert.deepEqual(errors, []);
  await allocateNodeWorktree(store, store.getNode(a.nodeId)!);
  assert.equal(
    await readFile(join(store.workspaces.get(project.projectId)!.path, 'result.txt'), 'utf8'),
    'A result',
  );
  assert.equal((await storageUse(store)).folders, 1);
});
