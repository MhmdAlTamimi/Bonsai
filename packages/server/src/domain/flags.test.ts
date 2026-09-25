import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFlags } from './flags.js';

const committed = { headCommit: 'c1' };
const commitless = { headCommit: null };

describe('deriveFlags', () => {
  test('createsBranch is an outcome of this node, not of its children', () => {
    assert.deepEqual(deriveFlags(commitless, [committed]), {
      createsBranch: false,
      isLeaf: false,
      hasCommits: false,
    });
  });

  test('isLeaf depends on children, not their commit state', () => {
    const flags = deriveFlags(committed, [commitless]);
    assert.equal(flags.isLeaf, false);
    assert.equal(deriveFlags(committed, [committed]).isLeaf, false);
  });
});
