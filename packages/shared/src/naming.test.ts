import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { deriveNodeName } from './naming.ts';

/**
 * Naming a node from what was asked for.
 *
 * The bar is low and specific: the result has to be a plausible label a person
 * would not immediately rename. It does NOT have to be a good summary — a
 * heuristic that is obviously mechanical reads as a default you may edit,
 * while one that is nearly-clever reads as a mistake the tool made.
 *
 * Shared between the dialog, which shows this as you type, and the server,
 * which fills it in when the request omits a name. If they ever disagree, a
 * node arrives on the canvas under a different name from the one the user was
 * just shown.
 */
describe('deriveNodeName', () => {
  test('takes the first few words of the request', () => {
    assert.equal(deriveNodeName('add a --verbose flag to the CLI'), 'add a --verbose flag to the');
    assert.equal(deriveNodeName('use argparse'), 'use argparse');
  });

  test('drops the words that start a request and identify nothing', () => {
    // "can you please" is the same six words in front of every third node.
    assert.equal(deriveNodeName('can you please add caching'), 'add caching');
    assert.equal(deriveNodeName("let's try switching to Redis"), 'switching to Redis');
  });

  test('keeps a question a question', () => {
    // `?` is how a conversation-only node is asked for. Losing it would make
    // the card read as a change to the code.
    assert.equal(deriveNodeName('?why is the parser so slow'), '? why is the parser so slow');
  });

  test('never returns something that reads as broken', () => {
    for (const input of ['', '   ', '\n\n', '- ', '###']) {
      assert.equal(deriveNodeName(input), 'untitled', JSON.stringify(input));
    }
    // A truncated sentence must not keep its dangling punctuation.
    assert.ok(!deriveNodeName('rewrite the parser, then benchmark it').endsWith(','));
  });

  test('stays short enough for a card', () => {
    const long = deriveNodeName(
      'replace the entire authentication subsystem with something considerably better',
    );
    assert.ok(long.length <= 43, `${long.length}: ${long}`);
  });

  test('a request that is only noise still gets a name', () => {
    // Stripping every word would fall back to "untitled", which is worse than
    // the words the user actually typed.
    assert.equal(deriveNodeName('can you'), 'you');
  });

  test('the fallback is caller-chosen, so the dialog can show nothing', () => {
    // The dialog passes '' so an empty box shows a dash rather than the word
    // "untitled", which would look like a name it had already decided on.
    assert.equal(deriveNodeName('', ''), '');
  });
});
