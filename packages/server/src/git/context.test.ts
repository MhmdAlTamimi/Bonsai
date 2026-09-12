import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { testingSection } from './context.js';

/**
 * Pulling the agent's own account of what it checked out of CONTEXT.md.
 *
 * The forgiveness here is the point. The agent writes prose, not a data format,
 * and a parser that only matched a literal "## Testing" would silently turn the
 * whole feature off the first time it wrote "## Verification" instead -- with
 * no error anywhere, just an empty panel section and a user concluding the
 * agent ignored them.
 */
describe('the testing section of CONTEXT.md', () => {
  test('finds it under the headings an agent actually writes', () => {
    for (const heading of [
      '## Testing',
      '### Testing',
      '## Verification',
      '## Checks',
      '## check',
    ]) {
      const md = `# Context\n\nDid a thing.\n\n${heading}\n\nRan pytest — 12 passed.\n`;
      assert.equal(testingSection(md), 'Ran pytest — 12 passed.', heading);
    }
  });

  test('stops at the next heading of the same level or shallower', () => {
    const md = [
      '# Context',
      '',
      '## Testing',
      '',
      'Ran `npm test` — 104 passed, 0 failed.',
      '',
      '### Caveat',
      '',
      'The browser test was skipped.',
      '',
      '## Notes for later',
      '',
      'The cache layer is still naive.',
    ].join('\n');

    const section = testingSection(md);
    // A deeper heading inside the section belongs to it.
    assert.match(section ?? '', /Caveat/);
    assert.match(section ?? '', /browser test was skipped/);
    // A sibling heading ends it.
    assert.ok(!(section ?? '').includes('cache layer'));
  });

  test('is null when there is nothing to report', () => {
    assert.equal(testingSection(null), null);
    assert.equal(testingSection('# Context\n\nJust answered a question.\n'), null);
    // A heading with nothing under it is not an answer.
    assert.equal(testingSection('# Context\n\n## Testing\n\n## Next\n\nmore'), null);
  });

  test('does not match a heading that merely mentions testing', () => {
    // "## Testing strategy for later" is a plan, not a result -- but it does
    // start with the word, so it matches. Asserted so the looseness is a
    // decision on the record rather than a surprise: a false positive here
    // shows the user prose they wrote-adjacent text, which is recoverable,
    // while a false negative shows them nothing and looks like a bug.
    const md = '# Context\n\n## Testing strategy\n\nWe should add integration tests.\n';
    assert.equal(testingSection(md), 'We should add integration tests.');

    // A heading about something else entirely is left alone.
    assert.equal(testingSection('# Context\n\n## Design\n\nUsed a trie.\n'), null);
  });
});
