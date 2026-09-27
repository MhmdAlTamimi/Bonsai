import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitLine, gitPatch } from './exec.js';
import { adoptDirectory, snapshotUncommitted } from './adopt.js';
import { seedFiles } from './seedWorktree.js';
import { readGitState } from './ownership.js';
import { commitRunOutput } from './commit.js';
import { removeWorktree } from './worktree.js';
import { reviewFiles, reviewFilePatch, totalsOf } from './review.js';

let root: string;
let repo: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bonsai-safety-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git(['init', '--initial-branch=main'], repo);
  await writeFile(join(repo, 'file.txt'), 'one\ntwo\n'.repeat(5));
  await writeFile(join(repo, '.gitignore'), '.env\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'base'], repo);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('detached adoption rejects without changing main or the checkout', async () => {
  const main = await gitLine(['rev-parse', 'main'], repo);
  await git(['checkout', '--detach'], repo);
  await writeFile(join(repo, 'file.txt'), 'detached work');
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'detached'], repo);
  const head = await gitLine(['rev-parse', 'HEAD'], repo);
  await assert.rejects(adoptDirectory(repo), /detached HEAD/);
  assert.equal(await gitLine(['rev-parse', 'main'], repo), main);
  assert.equal(await gitLine(['rev-parse', 'HEAD'], repo), head);
  assert.equal(await gitLine(['branch', '--show-current'], repo), '');
});

test('snapshot includes untracked, excludes ignored, and preserves refs and the real index', async () => {
  const head = await gitLine(['rev-parse', 'HEAD'], repo);
  await writeFile(join(repo, 'file.txt'), 'staged\n');
  await git(['add', 'file.txt'], repo);
  await writeFile(join(repo, 'file.txt'), 'unstaged\n');
  await writeFile(join(repo, 'new.txt'), 'new\n');
  await writeFile(join(repo, '.env'), 'secret');
  const index = await readFile(join(repo, '.git/index'));
  const snapshot = await snapshotUncommitted(repo);
  assert.ok(snapshot);
  assert.equal(await git(['show', `${snapshot}:new.txt`], repo), 'new\n');
  assert.equal(await git(['show', `${snapshot}:file.txt`], repo), 'unstaged\n');
  await assert.rejects(git(['show', `${snapshot}:.env`], repo));
  assert.deepEqual(await readFile(join(repo, '.git/index')), index);
  assert.equal(await gitLine(['rev-parse', 'HEAD'], repo), head);
});

test('copy-in uses destination ignore rules and rejects symlink paths and failed inspection', async () => {
  const target = join(root, 'target');
  await git(['worktree', 'add', '--detach', target, 'HEAD'], repo);
  await writeFile(join(repo, '.env'), 'secret');
  await writeFile(join(target, '.gitignore'), '');
  assert.equal(
    (await seedFiles({ sourceDir: repo, targetDir: target, files: ['.env'] }))[0]?.copied,
    false,
  );
  await writeFile(join(target, '.gitignore'), '.env\n');
  const outside = join(root, 'outside');
  await writeFile(outside, 'keep');
  await symlink(outside, join(target, '.env'));
  assert.equal(
    (await seedFiles({ sourceDir: repo, targetDir: target, files: ['.env'] }))[0]?.copied,
    false,
  );
  assert.equal(await readFile(outside, 'utf8'), 'keep');
  await rm(join(target, '.env'));
  await rm(join(target, '.git'));
  assert.equal(
    (await seedFiles({ sourceDir: repo, targetDir: target, files: ['.env'] }))[0]?.copied,
    false,
  );
});

test('a clean external commit is detected and never silently adopted', async () => {
  const expectedState = await readGitState(repo);
  await writeFile(join(repo, 'external.txt'), 'outside Bonsai');
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'external'], repo);
  const head = await gitLine(['rev-parse', 'HEAD'], repo);
  await assert.rejects(
    commitRunOutput({
      repoPath: repo,
      worktreePath: repo,
      branchName: 'main',
      message: 'app',
      expectedState,
    }),
    /changed outside Bonsai/,
  );
  assert.equal(await gitLine(['rev-parse', 'HEAD'], repo), head);
});

test('failed Git removal cannot delete an unregistered directory', async () => {
  const unrelated = join(root, 'unrelated');
  await mkdir(unrelated);
  await writeFile(join(unrelated, 'keep'), 'keep');
  await assert.rejects(removeWorktree(repo, unrelated));
  assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'keep');
});

test('review uses cumulative changes, including a dirty rename, deletion and new file', async () => {
  const base = await gitLine(['rev-parse', 'HEAD'], repo);
  await writeFile(join(repo, 'file.txt'), 'one\ntwo\n'.repeat(5) + 'three\n');
  await writeFile(join(repo, 'later-deleted.txt'), 'temporary\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-m', 'first run'], repo);
  const head = await gitLine(['rev-parse', 'HEAD'], repo);
  await git(['mv', 'file.txt', 'renamed.txt'], repo);
  await writeFile(join(repo, 'renamed.txt'), 'one\ntwo\n'.repeat(5) + 'three\nfour\n');
  await rm(join(repo, 'later-deleted.txt'));
  await writeFile(join(repo, 'new.txt'), 'new\n');
  const range = { base, head };
  const files = await reviewFiles({ cwd: repo, committedOnly: false }, range);
  assert.equal(
    files.some((f) => f.path === 'later-deleted.txt'),
    false,
    'added then deleted cancels out',
  );
  const renamed = files.find((f) => f.path === 'renamed.txt')!;
  assert.equal(renamed.oldPath, 'file.txt');
  assert.equal(renamed.additions, 2);
  assert.equal(renamed.uncommitted, true);
  assert.deepEqual(totalsOf(files), { files: 2, added: 3, removed: 0 });
  const patch = await reviewFilePatch({ cwd: repo, committedOnly: false }, range, renamed);
  assert.match(patch.patch, /\+three/);
  assert.match(patch.patch, /\+four/);
});

test('large patch output is drained with an explicit bounded result', async () => {
  await writeFile(join(repo, 'file.txt'), 'large line\n'.repeat(10000));
  const { patch, truncated } = await gitPatch(['diff', 'HEAD', '--'], repo, 1024);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(patch) <= 1024);
  assert.match(patch, /diff --git/);
});
