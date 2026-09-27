import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bytes, plural } from './words.ts';

test('counts read as words, with the plural the word needs', () => {
  assert.equal(plural(1, 'run'), '1 run');
  assert.equal(plural(0, 'run'), '0 runs');
  assert.equal(plural(2, 'match', 'matches'), '2 matches');
  assert.equal(plural(1204, 'file'), `${(1204).toLocaleString()} files`);
});

test('sizes on disk read in the unit that keeps them short', () => {
  assert.equal(bytes(0), '0 bytes');
  assert.equal(bytes(840_000), '840 KB');
  assert.equal(bytes(1_234_000_000), '1.2 GB');
  assert.equal(bytes(12_500_000), '12.5 MB');
});
