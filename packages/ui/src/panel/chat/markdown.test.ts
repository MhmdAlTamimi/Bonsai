import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseInline, parseMarkdown, type Block, type Inline } from './markdown.ts';

/** The shapes assertions care about, without repeating the discriminated union. */
function kinds(blocks: Block[]): string[] {
  return blocks.map((b) => b.kind);
}

function plain(content: Inline[]): string {
  return content
    .map((i) =>
      i.kind === 'text' || i.kind === 'code'
        ? i.text
        : i.kind === 'link' || i.kind === 'strong' || i.kind === 'em'
          ? plain(i.children)
          : '',
    )
    .join('');
}

test('a bare line is a paragraph', () => {
  assert.deepEqual(kinds(parseMarkdown('hello there')), ['paragraph']);
});

test('blank lines separate paragraphs, and runs of them do not make empty ones', () => {
  assert.deepEqual(kinds(parseMarkdown('one\n\n\n\ntwo')), ['paragraph', 'paragraph']);
});

test('headings carry their level', () => {
  const blocks = parseMarkdown('# one\n## two\n### three');
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'heading' ? b.level : null)),
    [1, 2, 3],
  );
});

test('four hashes is not a heading', () => {
  assert.deepEqual(kinds(parseMarkdown('#### nope')), ['paragraph']);
});

test('a fenced block keeps its language and its body verbatim', () => {
  const blocks = parseMarkdown('```python\nif x:\n    pass\n```');
  const [block] = blocks;
  assert.equal(block?.kind, 'code');
  if (block?.kind !== 'code') return;
  assert.equal(block.lang, 'python');
  assert.equal(block.text, 'if x:\n    pass');
});

/**
 * The case that made this parser necessary rather than a regex: markdown syntax
 * INSIDE a code block must not be re-parsed, or every agent reply that explains
 * markdown renders as headings and lists.
 */
test('markdown inside a fence stays code', () => {
  const blocks = parseMarkdown('```\n# not a heading\n- not a list\n```');
  assert.deepEqual(kinds(blocks), ['code']);
  const [block] = blocks;
  if (block?.kind !== 'code') return;
  assert.equal(block.text, '# not a heading\n- not a list');
});

test('an unterminated fence still yields the partial code', () => {
  const blocks = parseMarkdown('```js\nconst a = 1;');
  assert.deepEqual(kinds(blocks), ['code']);
});

test('a fence with no language has none', () => {
  const [block] = parseMarkdown('```\nplain\n```');
  assert.equal(block?.kind === 'code' ? block.lang : 'unset', null);
});

test('consecutive bullets are one list', () => {
  const blocks = parseMarkdown('- a\n- b\n- c');
  assert.deepEqual(kinds(blocks), ['list']);
  const [block] = blocks;
  if (block?.kind !== 'list') return;
  assert.equal(block.ordered, false);
  assert.equal(block.items.length, 3);
});

test('numbered items make an ordered list, and do not merge with bullets', () => {
  const blocks = parseMarkdown('1. a\n2. b\n- c');
  assert.deepEqual(kinds(blocks), ['list', 'list']);
  const [first, second] = blocks;
  assert.equal(first?.kind === 'list' ? first.ordered : null, true);
  assert.equal(second?.kind === 'list' ? second.ordered : null, false);
});

test('adjacent quote lines are one block', () => {
  const blocks = parseMarkdown('> one\n> two');
  assert.deepEqual(kinds(blocks), ['quote']);
});

test('inline code is not re-parsed', () => {
  const inline = parseInline('use `**literal**` here');
  assert.deepEqual(
    inline.map((i) => i.kind),
    ['text', 'code', 'text'],
  );
  assert.equal(inline[1]?.kind === 'code' ? inline[1].text : null, '**literal**');
});

test('bold and italic nest text', () => {
  assert.equal(parseInline('**bold**')[0]?.kind, 'strong');
  assert.equal(parseInline('*italic*')[0]?.kind, 'em');
  assert.equal(parseInline('_italic_')[0]?.kind, 'em');
});

test('an asterisk that opens nothing stays text', () => {
  assert.deepEqual(
    parseInline('2 * 3 = 6').map((i) => i.kind),
    ['text'],
  );
});

test('an http link is a link', () => {
  const [first] = parseInline('[docs](https://example.com/x)');
  assert.equal(first?.kind, 'link');
  assert.equal(first?.kind === 'link' ? first.href : null, 'https://example.com/x');
});

/**
 * Reachable from file contents the agent read, so it is refused rather than
 * rendered. The assertion is the property that matters -- no link element, and
 * the label still visible -- not the node count: a URL containing a bracket
 * leaves a stray character behind, which is ugly and harmless.
 */
test('a javascript: link degrades to its label', () => {
  const inline = parseInline('[click](javascript:alert(1))');
  assert.ok(!inline.some((i) => i.kind === 'link'));
  assert.ok(plain(inline).startsWith('click'));
});

test('a data: link degrades too', () => {
  const inline = parseInline('[x](data:text/html,hello)');
  assert.ok(!inline.some((i) => i.kind === 'link'));
  assert.equal(plain(inline), 'x');
});

test('adjacent text runs are merged into one node', () => {
  assert.deepEqual(parseInline('a * b * c'), [{ kind: 'text', text: 'a * b * c' }]);
});

test('nothing is dropped: every character survives a round trip as text', () => {
  const source = 'plain **bold** and `code` and [a](https://x.test) end';
  assert.equal(plain(parseInline(source)), 'plain bold and code and a end');
});

test('empty input is no blocks, not one empty paragraph', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('\n\n  \n'), []);
});

test('a realistic reply parses into the blocks it looks like', () => {
  const reply = [
    'I added the flag.',
    '',
    '## What changed',
    '',
    '- `cli.py` gained a `--json` option',
    '- the formatter is reused',
    '',
    '```python',
    'parser.add_argument("--json")',
    '```',
    '',
    'Run it with `todo list --json`.',
  ].join('\n');
  assert.deepEqual(kinds(parseMarkdown(reply)), [
    'paragraph',
    'heading',
    'list',
    'code',
    'paragraph',
  ]);
});
