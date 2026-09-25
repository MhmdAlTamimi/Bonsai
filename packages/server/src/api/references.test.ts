import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { referenceContent, referenceName } from './references.js';
import { HttpError } from './http.js';

describe('reference input', () => {
  test('a name is tidied into something @ can find again', () => {
    assert.equal(referenceName('  smoke   test '), 'smoke test');
  });

  test('names that could not be mentioned are refused with a reason', () => {
    for (const bad of ['', '   ', '@smoke', 'x'.repeat(81), 42]) {
      assert.throws(() => referenceName(bad), HttpError, JSON.stringify(bad));
    }
  });

  test('content is kept exactly, but must say something', () => {
    assert.equal(referenceContent('  line one\n\nline two  '), '  line one\n\nline two  ');
    assert.throws(() => referenceContent('   \n '), HttpError);
    assert.throws(() => referenceContent('x'.repeat(100_001)), HttpError);
  });
});
