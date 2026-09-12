import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openInMemory } from '../db/open.js';
import { Store } from '../db/store.js';
import { createChildNode, createProject } from '../projects.js';
import { rejectPath, seedFiles } from './seedWorktree.js';
import { commitRunOutput } from './commit.js';
import { branchNameFor } from './repo.js';
import { git, gitLine } from './exec.js';

/**
 * Giving a new node what git left behind.
 *
 * The test that matters most is the refusal: Bonsai commits with `git add -A`,
 * so copying a TRACKED .env into a node would commit the user's secrets to a
 * branch -- in an adopted project, a branch inside their own repository. That
 * is the kind of mistake that is discovered by someone else, later, in a git
 * history that cannot be quietly edited.
 */
describe('seeding a new node', () => {
  let root: string;
  let db: DatabaseSync;
  let store: Store;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-seed-'));
    db = openInMemory();
    store = new Store(db, join(root, 'repos'));
  });

  afterEach(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });

  /** A project folder with a gitignored .env, as a real one would have. */
  async function projectFolder(): Promise<string> {
    const path = join(root, 'app');
    await mkdir(path, { recursive: true });
    await git(['init', '--initial-branch=main', '.'], path);
    await git(['config', 'user.email', 'you@example.com'], path);
    await git(['config', 'user.name', 'You'], path);
    await writeFile(join(path, '.gitignore'), '.env\n', 'utf8');
    await writeFile(join(path, '.env'), 'SECRET=hunter2\n', 'utf8');
    await writeFile(join(path, 'app.py'), 'print("hi")\n', 'utf8');
    await git(['add', '-A'], path);
    await git(['commit', '-m', 'first'], path);
    return path;
  }

  test('copies a gitignored file into the new worktree', async () => {
    const source = await projectFolder();
    const target = join(root, 'node-1');
    await mkdir(target, { recursive: true });

    const [outcome] = await seedFiles({ sourceDir: source, targetDir: target, files: ['.env'] });

    assert.equal(outcome?.copied, true);
    assert.equal(await readFile(join(target, '.env'), 'utf8'), 'SECRET=hunter2\n');
  });

  test('copies, never links: editing the copy leaves the original alone', async () => {
    const source = await projectFolder();
    const target = join(root, 'node-2');
    await mkdir(target, { recursive: true });
    await seedFiles({ sourceDir: source, targetDir: target, files: ['.env'] });

    // An agent editing its own .env must not touch the user's.
    await writeFile(join(target, '.env'), 'SECRET=changed-by-the-agent\n', 'utf8');
    assert.equal(await readFile(join(source, '.env'), 'utf8'), 'SECRET=hunter2\n');
  });

  test('refuses a tracked file, and says why without offering to fix it', async () => {
    const source = await projectFolder();
    // The same file, but committed -- someone who did not gitignore it.
    await writeFile(join(source, 'config.env'), 'SECRET=tracked\n', 'utf8');
    await git(['add', '-A'], source);
    await git(['commit', '-m', 'oops'], source);

    const target = join(root, 'node-3');
    await mkdir(target, { recursive: true });
    const [outcome] = await seedFiles({
      sourceDir: source,
      targetDir: target,
      files: ['config.env'],
    });

    assert.equal(outcome?.copied, false);
    assert.match(outcome?.reason ?? '', /tracked by git/);
    assert.equal(existsSync(join(target, 'config.env')), false);
    // And .gitignore is untouched: it is tracked, it exists in every worktree,
    // and in an adopted project it is the user's. Changing it is a request to
    // make of the agent, not something a settings field does behind their back.
    assert.equal(await readFile(join(source, '.gitignore'), 'utf8'), '.env\n');
  });

  test('a tracked secret cannot reach a commit, end to end', async () => {
    // The failure this is really guarding against, played out: if the refusal
    // above were dropped, the file would be copied and then swept up by
    // `git add -A` into a branch in the user's own repository.
    const source = await projectFolder();
    await writeFile(join(source, 'config.env'), 'SECRET=tracked\n', 'utf8');
    await git(['add', '-A'], source);
    await git(['commit', '-m', 'oops'], source);

    const created = await createProject(store, {
      name: 'p',
      description: '',
      model: null,
      permissionMode: 'default',
    });
    store.updateProjectSetup(created.projectId, { copyFiles: ['config.env'] });

    const { nodeId, seeded } = await createChildNode(store, {
      projectId: created.projectId,
      parentId: created.masterNodeId,
      displayName: 'child',
      description: '',
    });

    assert.equal(seeded.length, 1);
    assert.equal(seeded[0]?.copied, false);
    const node = store.getNode(nodeId)!;
    assert.equal(existsSync(join(node.worktree_path, 'config.env')), false);

    // A run commits; the secret is not in it.
    await writeFile(join(node.worktree_path, 'real-work.txt'), 'x', 'utf8');
    const outcome = await commitRunOutput({
      repoPath: store.getProject(created.projectId)!.repo_path,
      worktreePath: node.worktree_path,
      branchName: branchNameFor(nodeId),
      message: 'work',
    });
    assert.equal(outcome.committed, true);
    const files = await gitLine(
      ['show', '--name-only', '--format=', outcome.commit!],
      node.worktree_path,
    );
    assert.ok(!files.includes('config.env'));
  });

  test('a missing file is reported, not silently skipped', async () => {
    const source = await projectFolder();
    const target = join(root, 'node-4');
    await mkdir(target, { recursive: true });
    const [outcome] = await seedFiles({
      sourceDir: source,
      targetDir: target,
      files: ['.env.production'],
    });
    assert.equal(outcome?.copied, false);
    assert.match(outcome?.reason ?? '', /not found/);
  });

  test('nested paths are created as needed', async () => {
    const source = await projectFolder();
    await mkdir(join(source, 'config'), { recursive: true });
    await writeFile(join(source, 'config', 'local.json'), '{}', 'utf8');
    const target = join(root, 'node-5');
    await mkdir(target, { recursive: true });

    const [outcome] = await seedFiles({
      sourceDir: source,
      targetDir: target,
      files: ['config/local.json'],
    });
    assert.equal(outcome?.copied, true, outcome?.reason);
    assert.equal(await readFile(join(target, 'config', 'local.json'), 'utf8'), '{}');
  });

  describe('paths that are never allowed', () => {
    test('dependency directories, whatever the setting says', () => {
      assert.match(rejectPath('node_modules') ?? '', /too large/);
      assert.match(rejectPath('node_modules/left-pad') ?? '', /too large/);
      // A virtualenv is not merely large: its scripts bake in the absolute
      // path of the directory they were made in, so a copy runs the wrong
      // interpreter and fails confusingly, at the moment tests are run.
      assert.match(rejectPath('.venv') ?? '', /absolute paths/);
      assert.match(rejectPath('backend/.venv') ?? '', /absolute paths/);
    });

    test('anything outside the project folder', () => {
      assert.match(rejectPath('/etc/passwd') ?? '', /absolute path/);
      assert.match(rejectPath('../../.ssh/id_rsa') ?? '', /inside the project/);
      assert.match(rejectPath('config/../../secrets') ?? '', /inside the project/);
    });

    test('an ordinary path is allowed', () => {
      assert.equal(rejectPath('.env'), null);
      assert.equal(rejectPath('config/local.json'), null);
    });
  });
});
