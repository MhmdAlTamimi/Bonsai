import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitLine } from './exec.js';
import { addDetachedWorktree, removeWorktree } from './worktree.js';

test('a new checkout contains its pinned submodule code and can be removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bonsai-submodules-'));
  try {
    const module = join(root, 'module');
    const repo = join(root, 'repo');
    const checkout = join(root, 'checkout');
    for (const path of [module, repo]) {
      await mkdir(path);
      await git(['init', '--initial-branch=main'], path);
      await writeFile(join(path, 'app.txt'), 'pinned\n');
      await git(['add', '-A'], path);
      await git(['commit', '-m', 'initial'], path);
    }
    await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'lib'], repo);
    await git(['commit', '-am', 'submodule'], repo);
    const base = await gitLine(['rev-parse', 'HEAD'], repo);
    // Only this test fixture permits local file transports.
    const old = process.env['GIT_ALLOW_PROTOCOL'];
    process.env['GIT_ALLOW_PROTOCOL'] = 'file';
    try {
      await addDetachedWorktree(repo, checkout, base);
    } finally {
      if (old === undefined) delete process.env['GIT_ALLOW_PROTOCOL'];
      else process.env['GIT_ALLOW_PROTOCOL'] = old;
    }
    assert.equal(await readFile(join(checkout, 'lib', 'app.txt'), 'utf8'), 'pinned\n');
    assert.equal(await gitLine(['rev-parse', 'HEAD'], checkout), base);
    assert.equal(await gitLine(['status', '--porcelain'], checkout), '');
    await removeWorktree(repo, checkout);
    assert.equal(await readFile(join(repo, 'lib', 'app.txt'), 'utf8'), 'pinned\n');
    await git(
      ['config', '-f', '.gitmodules', 'submodule.lib.url', join(root, 'missing-module')],
      repo,
    );
    await git(['commit', '-am', 'unavailable module'], repo);
    const failedCheckout = join(root, 'failed-checkout');
    await assert.rejects(
      addDetachedWorktree(repo, failedCheckout, await gitLine(['rev-parse', 'HEAD'], repo)),
      /Could not initialise/,
    );
    await assert.rejects(readFile(join(failedCheckout, 'app.txt')), { code: 'ENOENT' });
    assert.doesNotMatch(
      await gitLine(['worktree', 'list', '--porcelain'], repo),
      /failed-checkout/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
