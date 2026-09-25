import { test } from 'node:test';
import assert from 'node:assert/strict';

import { plural } from './words.ts';

test('counts read as words, with the plural the word needs', () => {
  assert.equal(plural(1, 'run'), '1 run');
  assert.equal(plural(0, 'run'), '0 runs');
  assert.equal(plural(2, 'match', 'matches'), '2 matches');
  assert.equal(plural(1204, 'file'), `${(1204).toLocaleString()} files`);
});
