import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitInput, gitLine, gitPatch } from './exec.js';

describe('Bonsai Git invocation policy', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bonsai-git-policy-'));
    await git(['init', '--initial-branch=main', '.'], root);
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  test('failing user hooks and signing settings do not affect Bonsai or change config', async () => {
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 42\n');
    await chmod(hook, 0o755);
    await git(['config', 'commit.gpgsign', 'true'], root);
    await git(['config', 'gpg.program', 'nonexistent-bonsai-test-signer'], root);
    await writeFile(join(root, 'app.txt'), 'before\n');
    await git(['add', '-A'], root);
    await git(['commit', '-m', 'Bonsai commit'], root);
    const config = await readFile(join(root, '.git', 'config'), 'utf8');
    assert.match(config, /gpgsign = true/);
    assert.match(config, /program = nonexistent-bonsai-test-signer/);
    assert.doesNotMatch(config, /hooksPath|noprefix/);
    assert.equal(await readFile(hook, 'utf8'), '#!/bin/sh\nexit 42\n');
  });

  test('system configuration remains readable', async () => {
    const config = join(root, 'system.gitconfig');
    await writeFile(config, '[filter "bonsai-test"]\n\tclean = cat\n\trequired = true\n');
    assert.equal(
      (
        await git(['config', '--get', 'filter.bonsai-test.required'], root, {
          GIT_CONFIG_SYSTEM: config,
        })
      ).trim(),
      'true',
    );
  });

  test('diff output has stable prefixes and never executes external diff helpers', async () => {
    await writeFile(join(root, 'app.txt'), 'before\n');
    await git(['add', '-A'], root);
    await git(['commit', '-m', 'before'], root);
    await git(['config', 'diff.noprefix', 'true'], root);
    await git(['config', 'diff.external', 'nonexistent-bonsai-test-diff'], root);
    await writeFile(join(root, 'app.txt'), 'after\n');
    assert.match(await git(['diff'], root), /--- a\/app.txt\n\+\+\+ b\/app.txt/);
    assert.match((await gitPatch(['diff'], root)).patch, /--- a\/app.txt\n\+\+\+ b\/app.txt/);
    const tree = (await gitInput(['mktree'], root, '')).trim();
    assert.equal(await gitLine(['cat-file', '-t', tree], root), 'tree');
  });

  test('reports a missing cwd with its path rather than empty stderr', async () => {
    const missing = join(root, 'moved-away');
    await assert.rejects(git(['status'], missing), /repository folder is missing:.*moved-away/);
    await assert.rejects(gitPatch(['diff'], missing), /repository folder is missing:.*moved-away/);
  });
});
