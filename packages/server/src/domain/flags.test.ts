import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFlags, isWritable } from './flags.js';

const committed = { headCommit: 'c1' };
const commitless = { headCommit: null };

describe('isWritable', () => {
  test('a leaf is writable', () => {
    assert.equal(isWritable([]), true);
  });

  test('a committed child freezes the parent', () => {
    assert.equal(isWritable([committed]), false);
  });

  test('a commitless child does NOT freeze the parent', () => {
    // The correction that started this: `writable = creates_branch && isLeaf`
    // would have frozen this node. Nothing has branched off its code, so
    // nothing can go stale, so it stays writable.
    assert.equal(isWritable([commitless]), true);
  });

  test('one committed child among several commitless ones still freezes', () => {
    assert.equal(isWritable([commitless, commitless, committed]), false);
  });
});

describe('deriveFlags', () => {
  test('createsBranch is an outcome of this node, not of its children', () => {
    assert.deepEqual(deriveFlags(commitless, [committed]), {
      createsBranch: false,
      writable: false,
      isLeaf: false,
      hasCommits: false,
    });
  });

  test('isLeaf is decoupled from writable', () => {
    const flags = deriveFlags(committed, [commitless]);
    assert.equal(flags.isLeaf, false);
    assert.equal(flags.writable, true);
  });
});
