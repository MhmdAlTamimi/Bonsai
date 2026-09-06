import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mutatesGit } from './guards.js';

describe('mutatesGit', () => {
  test('allows the read-only git that recovery depends on (D30)', () => {
    for (const cmd of [
      'git status --porcelain',
      'git diff HEAD',
      'git log --oneline -5',
      'git show HEAD',
      'git -C . status',
    ]) {
      assert.equal(mutatesGit(cmd), false, cmd);
    }
  });

  test('denies the verbs that would corrupt the tree', () => {
    for (const cmd of [
      'git commit -m x',
      'git branch feature',
      'git checkout main',
      'git switch -c other',
      'git merge other',
      'git reset --hard',
      'git clean -fd',
      'git worktree add /tmp/x',
    ]) {
      assert.equal(mutatesGit(cmd), true, cmd);
    }
  });

  test('sees past git flags to the verb', () => {
    assert.equal(mutatesGit('git -C /repo commit -m x'), true);
    assert.equal(mutatesGit('git -c user.name=x commit -m y'), true);
  });

  test('inspects each command in a chain', () => {
    assert.equal(mutatesGit('ls && git commit -m x'), true);
    assert.equal(mutatesGit('git status; git reset --hard'), true);
    assert.equal(mutatesGit('echo hi && git log'), false);
  });

  test('does not pretend to catch indirection', () => {
    // Documented limitation, asserted so nobody mistakes this for a sandbox.
    // The post-run head comparison is what actually protects the tree.
    assert.equal(mutatesGit('g=git; $g commit -m x'), false);
    assert.equal(mutatesGit("sh -c 'git commit -m x'"), false);
  });
});
