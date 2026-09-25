import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MENTION_LIMIT, matchMentions, mentionAt, withoutMention } from './mentions.ts';

describe('@ mentions in the composer', () => {
  test('finds the mention the caret is at the end of', () => {
    assert.deepEqual(mentionAt('@smo', 4), { start: 0, query: 'smo' });
    assert.deepEqual(mentionAt('run @smo', 8), { start: 4, query: 'smo' });
    assert.deepEqual(mentionAt('run\n@', 5), { start: 4, query: '' });
    // The caret decides, not the end of the text.
    assert.deepEqual(mentionAt('run @smo and more', 8), { start: 4, query: 'smo' });
  });

  test('leaves email addresses and finished words alone', () => {
    assert.equal(mentionAt('mail me@example.com', 19), null);
    assert.equal(mentionAt('run @smoke then', 15), null);
    assert.equal(mentionAt('no mention here', 15), null);
    assert.equal(mentionAt('@@', 2), null);
  });

  test('matches names that start with the query first, ignoring case', () => {
    const list = [{ name: 'redis-smoke' }, { name: 'Smoke-test' }, { name: 'bench' }];
    assert.deepEqual(
      matchMentions(list, 'smo').map((r) => r.name),
      ['Smoke-test', 'redis-smoke'],
    );
    assert.deepEqual(
      matchMentions(list, '').map((r) => r.name),
      ['redis-smoke', 'Smoke-test', 'bench'],
    );
    assert.deepEqual(matchMentions(list, 'zzz'), []);
  });

  test('offers a bounded number of matches', () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ name: `ref-${i}` }));
    assert.equal(matchMentions(list, 'ref').length, MENTION_LIMIT);
  });

  test('takes the typed mention out once it is a chip', () => {
    assert.deepEqual(withoutMention('run @smo', { start: 4, query: 'smo' }, 8), {
      text: 'run ',
      caret: 4,
    });
    assert.deepEqual(withoutMention('run @smo please', { start: 4, query: 'smo' }, 8), {
      text: 'run please',
      caret: 4,
    });
    assert.deepEqual(withoutMention('@', { start: 0, query: '' }, 1), { text: '', caret: 0 });
  });
});
