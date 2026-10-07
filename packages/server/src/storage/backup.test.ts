import {
  createLegacyProject as createProject,
  adoptLegacyProject as adoptProject,
} from '../testing/legacyProject.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename, readdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../db/open.js';
import { Store } from '../db/store.js';
import { Settings } from '../settings.js';
import { allocateNodeWorktree } from '../projects.js';
import { createAllocatedChild } from '../testing/allocatedChild.js';
import { git, gitLine } from '../git/exec.js';
import { gitRecovery } from '../git/reconcile.js';
import { removeWorktree } from '../git/worktree.js';
import { silentLogger } from '../log.js';
import { FakeRunner } from '../agent/FakeRunner.js';
import { RunJobs } from '../jobs/runNode.js';
import { ComparisonJobs } from '../jobs/comparisons.js';
import { EventBus } from '../api/events.js';
import { relocateManagedStorage } from './relocate.js';
import { makeBackup } from './backup.js';

let root: string;
let data: string;
let db: ReturnType<typeof openDatabase>;
let store: Store;
let settings: Settings;
const configure = (dataDir: string) =>
  new Settings({
    dataDir,
    reposRoot: join(dataDir, 'repos'),
    port: 0,
    defaultModel: null,
    defaultPermissionMode: 'acceptEdits',
  });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bonsai-backup-test-'));
  data = join(root, 'original', 'data');
  db = openDatabase(data);
  store = new Store(db, join(data, 'repos'));
  settings = configure(data);
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
const create = () =>
  createProject(store, {
    name: 'backup project',
    description: '',
    model: null,
    permissionMode: 'acceptEdits',
  });
const child = (projectId: string, parentId: string, name = 'child') =>
  createAllocatedChild(store, { projectId, parentId, displayName: name, description: '' });
async function restore(path: string): Promise<void> {
  const into = join(root, 'restored');
  db.close();
  await rename(path, into);
  await rm(join(root, 'original'), { recursive: true, force: true });
  data = into;
  db = openDatabase(data);
  store = new Store(db, join(data, 'repos'));
  settings = configure(data);
  const blocked: unknown[] = [];
  await relocateManagedStorage(
    store,
    data,
    {
      ...silentLogger,
      warn: (_event, details) => {
        blocked.push(details);
      },
    },
    settings,
  );
  assert.deepEqual(blocked, [], 'the complete backup must relocate without a recovery dead end');
}
async function contents(path: string): Promise<string> {
  let out = '';
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) out += await contents(file);
    else if (entry.isFile()) out += (await readFile(file)).toString();
  }
  return out;
}

test('a moved full backup survives losing original custom storage and retains dirty/index/ignored files, archived code and comparison snapshots', async () => {
  settings.update({ reposRoot: join(root, 'original', 'custom') });
  store = new Store(db, join(data, 'repos'), () => settings.reposRoot());
  const project = await create();
  const live = await child(project.projectId, project.masterNodeId);
  const archived = await child(project.projectId, project.masterNodeId, 'archived');
  const node = store.getNode(live.nodeId)!;
  await writeFile(join(node.worktree_path, '.gitignore'), 'valuable.bin\n');
  await writeFile(join(node.worktree_path, 'valuable.bin'), 'ignored work');
  await writeFile(join(node.worktree_path, 'staged.txt'), 'staged-only');
  await git(['add', 'staged.txt'], node.worktree_path);
  await writeFile(join(node.worktree_path, 'staged.txt'), 'working version');
  store.appendMessage({
    nodeId: node.id,
    runId: null,
    role: 'assistant',
    kind: 'text',
    content: 'durable conversation',
  });
  const bus = new EventBus();
  const comparisons = new ComparisonJobs(store, bus, new FakeRunner(), settings, silentLogger);
  const comparison = await comparisons.create(project.projectId, [
    store.getNode(project.masterNodeId)!,
    node,
  ]);
  await removeWorktree(
    store.getProject(project.projectId)!.repo_path,
    store.getNode(archived.nodeId)!.worktree_path,
  );
  store.nodes.markArchived(archived.nodeId);
  for (const name of ['recovery', 'exports', 'sessions']) {
    await mkdir(join(data, name));
    await writeFile(join(data, name, 'preserved.txt'), name);
  }
  const saved = await makeBackup(store, settings);
  assert.equal(JSON.parse(await readFile(join(saved.path, 'backup.json'), 'utf8')).complete, true);
  await restore(saved.path);
  const restored = store.getNode(node.id)!;
  assert.equal(await gitRecovery(store, restored), null);
  assert.equal(
    await readFile(join(restored.worktree_path, 'valuable.bin'), 'utf8'),
    'ignored work',
  );
  assert.equal(
    await readFile(join(restored.worktree_path, 'staged.txt'), 'utf8'),
    'working version',
  );
  assert.equal(await git(['show', ':staged.txt'], restored.worktree_path), 'staged-only');
  assert.equal(store.listMessages(node.id, 0).at(-1)?.content, 'durable conversation');
  assert.ok(store.comparisons.get(comparison.id));
  assert.match(
    await contents(join(data, 'repos', project.projectId, 'compare', comparison.id)),
    /backup project|master/,
  );
  await allocateNodeWorktree(store, store.getNode(archived.nodeId)!);
  for (const name of ['recovery', 'exports', 'sessions'])
    assert.equal(await readFile(join(data, name, 'preserved.txt'), 'utf8'), name);
  const jobs = new RunJobs(store, bus, new FakeRunner(), settings, silentLogger);
  jobs.start(archived.nodeId, 'continue from independent backup');
  for (let i = 0; i < 200 && jobs.activeCount() > 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(jobs.activeCount(), 0);
  assert.equal(store.listRuns(archived.nodeId).at(-1)?.status, 'done');
  await git(['fsck', '--full', '--no-dangling'], store.getProject(project.projectId)!.repo_path);
});

test('each adopted project gets its own independent repository and source snapshot without credentials or modifying the source', async () => {
  const source = join(root, 'original', 'source');
  await mkdir(source);
  await git(['init', '--initial-branch=main'], source);
  await writeFile(join(source, 'app.txt'), 'source');
  await git(['add', '-A'], source);
  await git(['commit', '-m', 'initial'], source);
  await git(
    ['config', 'remote.origin.url', 'https://audit-secret-canary@example.test/repo'],
    source,
  );
  await git(['config', 'credential.helper', '!audit-secret-canary'], source);
  settings.update({ apiKey: 'audit-secret-canary' });
  const configBefore = await readFile(join(source, '.git', 'config'), 'utf8');
  const projects = [];
  for (let i = 0; i < 2; i++) {
    const project = await adoptProject(store, {
      path: source,
      name: `adopted ${i}`,
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    projects.push({ ...project, child: await child(project.projectId, project.masterNodeId) });
  }
  await writeFile(join(source, 'local.txt'), 'uncommitted source');
  const saved = await makeBackup(store, settings);
  assert.equal(await readFile(join(source, '.git', 'config'), 'utf8'), configBefore);
  assert.doesNotMatch(await contents(saved.path), /audit-secret-canary/);
  await restore(saved.path);
  for (const project of projects) {
    const row = store.getProject(project.projectId)!;
    assert.ok(row.repo_path.startsWith(data));
    assert.ok(row.source_path!.startsWith(data));
    assert.equal(await gitRecovery(store, store.getNode(project.child.nodeId)!), null);
    assert.equal(await readFile(join(row.source_path!, 'local.txt'), 'utf8'), 'uncommitted source');
    assert.equal(await gitLine(['branch', '--show-current'], row.source_path!), 'main');
    await child(row.id, project.child.nodeId, 'continuation');
  }
  assert.notEqual(
    store.getProject(projects[0]!.projectId)!.repo_path,
    store.getProject(projects[1]!.projectId)!.repo_path,
  );
  // A restored backup can itself be backed up without borrowing its Git administration.
  const again = await makeBackup(store, settings);
  assert.equal(JSON.parse(await readFile(join(again.path, 'backup.json'), 'utf8')).complete, true);
});

test('a full backup preserves an initialized submodule and its staged and working versions independently', async () => {
  const module = join(root, 'original', 'module');
  const source = join(root, 'original', 'source');
  for (const path of [module, source]) {
    await mkdir(path);
    await git(['init', '--initial-branch=main'], path);
    await writeFile(join(path, 'app.txt'), 'original');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'initial'], path);
  }
  await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'lib'], source);
  await git(['commit', '-am', 'add module'], source);
  const previous = process.env['GIT_ALLOW_PROTOCOL'];
  process.env['GIT_ALLOW_PROTOCOL'] = 'file';
  try {
    const project = await adoptProject(store, {
      path: source,
      description: '',
      model: null,
      permissionMode: 'acceptEdits',
    });
    const experiment = await child(project.projectId, project.masterNodeId);
    const lib = join(store.getNode(experiment.nodeId)!.worktree_path, 'lib');
    await writeFile(join(lib, 'app.txt'), 'staged module');
    await git(['add', 'app.txt'], lib);
    await writeFile(join(lib, 'app.txt'), 'working module');
    const saved = await makeBackup(store, settings);
    await restore(saved.path);
    const restored = join(store.getNode(experiment.nodeId)!.worktree_path, 'lib');
    assert.equal(await readFile(join(restored, 'app.txt'), 'utf8'), 'working module');
    assert.equal(await git(['show', ':app.txt'], restored), 'staged module');
    await git(['fsck', '--full', '--no-dangling'], restored);
    assert.equal(
      await git(
        ['show', 'HEAD:app.txt'],
        join(store.getProject(project.projectId)!.source_path!, 'lib'),
      ),
      'original',
    );
    await child(project.projectId, experiment.nodeId, 'new submodule experiment');
  } finally {
    if (previous === undefined) delete process.env['GIT_ALLOW_PROTOCOL'];
    else process.env['GIT_ALLOW_PROTOCOL'] = previous;
  }
});

test('an outside edit during the snapshot refuses to mark the backup complete and preserves the edit', async () => {
  const project = await create();
  const node = store.getNode(project.masterNodeId)!;
  const preferences = settings.backupPreferences.bind(settings);
  settings.backupPreferences = (reposRoot) => {
    writeFileSync(join(node.worktree_path, 'outside.txt'), 'changed during backup');
    return preferences(reposRoot);
  };
  await assert.rejects(makeBackup(store, settings), /changed outside Bonsai.*incomplete/);
  assert.equal(
    await readFile(join(node.worktree_path, 'outside.txt'), 'utf8'),
    'changed during backup',
  );
  const [folder] = await readdir(join(data, 'backups'));
  assert.equal(
    JSON.parse(await readFile(join(data, 'backups', folder!, 'backup.json'), 'utf8')).complete,
    false,
  );
});
