import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { draftInput, draftInstruction, referenceContent, referenceName } from './references.js';
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

describe('draft input', () => {
  test('is the conversation, then what to write, then the current text when updating', () => {
    assert.equal(
      draftInput('## Conversation\n\nUser: hi', 'Summarise the results', null),
      '## Conversation\n\nUser: hi\n\n## What to write\n\nSummarise the results',
    );
    assert.match(
      draftInput('c', 'Add /metrics', 'Run npm test.'),
      /## What to write\n\nAdd \/metrics\n\n## The reference as it stands -- update it as asked\n\nRun npm test\.$/,
    );
  });

  test('needs a request, within reason', () => {
    assert.equal(draftInstruction('  Extract the test procedure '), 'Extract the test procedure');
    assert.throws(() => draftInstruction('  '), HttpError);
    assert.throws(() => draftInstruction('x'.repeat(2_001)), HttpError);
  });
});
