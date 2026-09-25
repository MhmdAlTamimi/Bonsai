import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { compactCommand } from './commands.ts';

describe('commands typed in the composer', () => {
  test('/compact alone compacts with no focus', () => {
    assert.deepEqual(compactCommand('/compact'), { focus: null });
    assert.deepEqual(compactCommand('  /compact  '), { focus: null });
  });

  test('what follows is the focus, on one line', () => {
    assert.deepEqual(compactCommand('/compact keep the\ntest results'), {
      focus: 'keep the test results',
    });
  });

  test('anything else is an ordinary message', () => {
    assert.equal(compactCommand('/compacted'), null);
    assert.equal(compactCommand('please /compact'), null);
    assert.equal(compactCommand('/clear'), null);
    assert.equal(compactCommand('compact this'), null);
  });
});
