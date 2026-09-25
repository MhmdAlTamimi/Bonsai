import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { basisLine } from './basis.ts';

describe('what a draft was written from', () => {
  test('the whole conversation, and the notes when there were any', () => {
    assert.equal(
      basisLine({ messages: 42, included: 42, toolOutputOmitted: false, notes: true }, 'try-redis'),
      'Written from all 42 messages of try-redis (with its CONTEXT.md notes).',
    );
    assert.equal(
      basisLine({ messages: 3, included: 3, toolOutputOmitted: false, notes: false }, 'master'),
      'Written from all 3 messages of master.',
    );
  });

  test('says when a long conversation was trimmed to fit', () => {
    assert.equal(
      basisLine({ messages: 900, included: 120, toolOutputOmitted: true, notes: false }, 'bench'),
      'Written from 120 of 900 messages of bench — the rest were left out to fit (tool output left out).',
    );
  });

  test('notes alone, before there is a conversation', () => {
    assert.equal(
      basisLine({ messages: 0, included: 0, toolOutputOmitted: false, notes: true }, 'bench'),
      "Written from bench's notes.",
    );
  });
});
