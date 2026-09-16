import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangedFile } from '@bonsai/shared';

import { buildTree, filterFiles, visibleRows, type FolderEntry } from './fileTree.ts';

const file = (
  path: string,
  added = 1,
  removed = 0,
  extra: Partial<ChangedFile> = {},
): ChangedFile => ({
  path,
  status: 'modified',
  added,
  removed,
  binary: false,
  notes: false,
  ...extra,
});

describe('changed files as a tree', () => {
  test('folders come first, in natural order, and carry their files’ counts', () => {
    const tree = buildTree([
      file('README.md', 2),
      file('src/b.py', 3, 1),
      file('src/a10.py', 1),
      file('src/a2.py', 1),
      file('docs/guide.md', 5, 2),
    ]);
    assert.deepEqual(
      tree.map((e) => e.name),
      ['docs', 'src', 'README.md'],
    );
    const src = tree[1] as FolderEntry;
    assert.deepEqual(
      src.children.map((e) => e.name),
      ['a2.py', 'a10.py', 'b.py'],
      'a2 before a10, as a person counts',
    );
    assert.deepEqual([src.files, src.added, src.removed], [3, 5, 1]);
  });

  test('a chain of single folders is one row', () => {
    const tree = buildTree([
      file('packages/ui/src/panel/changes/Tree.tsx'),
      file('packages/ui/src/panel/changes/tree.ts'),
    ]);
    assert.equal(tree.length, 1);
    const chain = tree[0] as FolderEntry;
    assert.equal(chain.name, 'packages/ui/src/panel/changes');
    assert.equal(chain.path, 'packages/ui/src/panel/changes');
    assert.equal(chain.children.length, 2);
  });

  test('a folder with a file and a folder in it is not merged', () => {
    const tree = buildTree([file('src/main.py'), file('src/lib/util.py')]);
    const src = tree[0] as FolderEntry;
    assert.equal(src.name, 'src');
    assert.deepEqual(
      src.children.map((e) => e.name),
      ['lib', 'main.py'],
    );
  });

  test('collapsed folders hide what is inside them, and levels count from 1', () => {
    const tree = buildTree([file('src/a.py'), file('src/lib/b.py'), file('top.py')]);
    const open = visibleRows(tree, new Set());
    assert.deepEqual(
      open.map((r) => [r.entry.name, r.level, r.parent]),
      [
        ['src', 1, null],
        ['lib', 2, 'src'],
        ['b.py', 3, 'src/lib'],
        ['a.py', 2, 'src'],
        ['top.py', 1, null],
      ],
    );
    assert.deepEqual(
      visibleRows(tree, new Set(['src'])).map((r) => r.entry.name),
      ['src', 'top.py'],
    );
  });

  test('filtering matches every word, in any case, and a renamed file’s old name', () => {
    const files = [
      file('src/Chunking/split.py'),
      file('src/embed.py'),
      file('notes/new.md', 1, 0, { status: 'renamed', oldPath: 'notes/draft.md' }),
    ];
    assert.deepEqual(
      filterFiles(files, 'chunk SPLIT').map((f) => f.path),
      ['src/Chunking/split.py'],
    );
    assert.deepEqual(
      filterFiles(files, 'draft').map((f) => f.path),
      ['notes/new.md'],
    );
    assert.equal(filterFiles(files, '   ').length, 3);
  });
});
