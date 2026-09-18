import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ReviewFile } from '@bonsai/shared';

import { ancestorsOf, buildTree, fileAfter, rowsOf } from './fileTree.ts';

const file = (path: string): ReviewFile => ({
  path,
  status: 'A',
  additions: 1,
  deletions: 0,
  binary: false,
});

const tree = buildTree([
  file('chunks/abwaab/chunk_001.md'),
  file('chunks/abwaab/chunk_002.md'),
  file('chunks/summary.json'),
  file('README.md'),
  file('src/chunk_writer.py'),
]);

describe('the review file tree', () => {
  test('folders come first, then files, each in natural order', () => {
    assert.deepEqual(
      tree.map((n) => n.name),
      ['chunks', 'src', 'README.md'],
    );
  });

  test('every row carries its depth, so the guides can be drawn', () => {
    const rows = rowsOf(tree, { collapsed: new Set(), selectedPath: null });
    assert.deepEqual(
      rows.map((r) => [r.node.name, r.depth]),
      [
        ['chunks', 0],
        ['abwaab', 1],
        ['chunk_001.md', 2],
        ['chunk_002.md', 2],
        ['summary.json', 1],
        ['src', 0],
        ['chunk_writer.py', 1],
        ['README.md', 0],
      ],
    );
  });

  test('the open file and the folders above it are the live path', () => {
    const rows = rowsOf(tree, {
      collapsed: new Set(),
      selectedPath: 'chunks/abwaab/chunk_002.md',
    });
    assert.deepEqual(
      rows.filter((r) => r.live).map((r) => r.node.path),
      ['chunks', 'chunks/abwaab', 'chunks/abwaab/chunk_002.md'],
    );
    assert.deepEqual([...ancestorsOf('chunks/abwaab/chunk_002.md')], ['chunks', 'chunks/abwaab']);
  });

  test('a collapsed folder hides its contents — unless the open file is inside it', () => {
    const collapsed = new Set(['chunks', 'chunks/abwaab']);
    assert.deepEqual(
      rowsOf(tree, { collapsed, selectedPath: null }).map((r) => r.node.name),
      ['chunks', 'src', 'chunk_writer.py', 'README.md'],
    );
    assert.deepEqual(
      rowsOf(tree, { collapsed, selectedPath: 'chunks/abwaab/chunk_001.md' }).map(
        (r) => r.node.name,
      ),
      [
        'chunks',
        'abwaab',
        'chunk_001.md',
        'chunk_002.md',
        'summary.json',
        'src',
        'chunk_writer.py',
        'README.md',
      ],
    );
  });

  test('filtering opens everything and drops folders with nothing in them', () => {
    const rows = rowsOf(tree, {
      collapsed: new Set(['chunks', 'chunks/abwaab']),
      selectedPath: null,
      filter: 'chunk_00',
    });
    assert.deepEqual(
      rows.map((r) => r.node.name),
      ['chunks', 'abwaab', 'chunk_001.md', 'chunk_002.md'],
    );
  });

  test('next and previous walk the files in the order they are shown', () => {
    const rows = rowsOf(tree, { collapsed: new Set(), selectedPath: null });
    assert.equal(fileAfter(rows, 'chunks/abwaab/chunk_001.md', 1), 'chunks/abwaab/chunk_002.md');
    assert.equal(
      fileAfter(rows, 'chunks/abwaab/chunk_001.md', -1),
      null,
      'nothing before the first',
    );
    assert.equal(fileAfter(rows, null, 1), 'chunks/abwaab/chunk_001.md', 'the first file');
    assert.equal(fileAfter(rows, 'README.md', 1), null, 'nothing after the last');
  });
});
