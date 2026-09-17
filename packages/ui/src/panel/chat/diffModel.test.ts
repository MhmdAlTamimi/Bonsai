import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePatch, patchTotals, shouldExpand, type DiffFile } from './diffModel.ts';

const TWO_FILES = [
  'diff --git a/cli.py b/cli.py',
  'index 1111111..2222222 100644',
  '--- a/cli.py',
  '+++ b/cli.py',
  '@@ -1,4 +1,6 @@',
  ' import argparse',
  '+import json',
  ' ',
  '-def main():',
  '+def main(as_json=False):',
  '     pass',
  'diff --git a/README.md b/README.md',
  'index 3333333..4444444 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  ' # todo',
  '+Now with --json.',
  '',
].join('\n');

test('a patch splits into one entry per file', () => {
  const files = parsePatch(TWO_FILES);
  assert.deepEqual(
    files.map((f) => f.path),
    ['cli.py', 'README.md'],
  );
});

/**
 * The bug this test exists for: `+++ b/cli.py` starts with `+` and `--- a/cli.py`
 * starts with `-`, so a naive classifier counts both as changed lines and every
 * file reports two more changes than it has.
 */
test('the +++ and --- headers are not counted as changes', () => {
  const [cli] = parsePatch(TWO_FILES);
  assert.equal(cli?.added, 2);
  assert.equal(cli?.removed, 1);
});

test('hunk headers are their own kind, not context', () => {
  const [cli] = parsePatch(TWO_FILES);
  assert.equal(cli?.lines.filter((l) => l.kind === 'hunk').length, 1);
});

test('index and mode lines are dropped entirely', () => {
  const [cli] = parsePatch(TWO_FILES);
  assert.ok(!cli?.lines.some((l) => l.text.startsWith('index ')));
});

test('markers are stripped from the rendered text', () => {
  const [cli] = parsePatch(TWO_FILES);
  const added = cli?.lines.find((l) => l.kind === 'add');
  assert.equal(added?.text, 'import json');
});

test('totals add up across files', () => {
  assert.deepEqual(patchTotals(parsePatch(TWO_FILES)), { files: 2, added: 3, removed: 1 });
});

test('an empty patch is no files, not one empty file', () => {
  assert.deepEqual(parsePatch(''), []);
  assert.deepEqual(parsePatch('   \n'), []);
});

test('a rename reports where the file ended up', () => {
  const files = parsePatch(
    [
      'diff --git a/old.py b/new.py',
      'similarity index 98%',
      'rename from old.py',
      'rename to new.py',
    ].join('\n'),
  );
  assert.equal(files[0]?.path, 'new.py');
});

test('a new file is a file with only additions', () => {
  const files = parsePatch(
    [
      'diff --git a/n.txt b/n.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/n.txt',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n'),
  );
  assert.equal(files[0]?.added, 2);
  assert.equal(files[0]?.removed, 0);
});

test('a binary file is marked and has no lines to show', () => {
  const files = parsePatch(
    [
      'diff --git a/logo.png b/logo.png',
      'index 5555555..6666666 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n'),
  );
  assert.equal(files[0]?.binary, true);
  assert.equal(files[0]?.lines.length, 0);
});

test("git's no-newline note is meta, not a change", () => {
  const files = parsePatch(
    [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '\\ No newline at end of file',
    ].join('\n'),
  );
  assert.equal(files[0]?.added, 1);
  assert.equal(files[0]?.lines.at(-1)?.kind, 'meta');
});

/** Showing an unlabelled diff beats claiming there were no changes. */
test('a patch with no git header still yields one file', () => {
  const files = parsePatch(['@@ -1 +1 @@', '-a', '+b'].join('\n'));
  assert.equal(files.length, 1);
  assert.equal(files[0]?.added, 1);
});

function fileOf(lineCount: number, binary = false): DiffFile {
  return {
    path: 'x',
    added: lineCount,
    removed: 0,
    binary,
    lines: Array.from({ length: lineCount }, () => ({ kind: 'add' as const, text: 'x' })),
  };
}

test('small early files open; long ones and later ones stay collapsed', () => {
  assert.equal(shouldExpand(fileOf(20), 0), true);
  assert.equal(shouldExpand(fileOf(500), 0), false);
  assert.equal(shouldExpand(fileOf(20), 9), false);
  assert.equal(shouldExpand(fileOf(0, true), 0), false);
});

test('file operations and line numbers describe additions, deletions and renames', () => {
  const [modified] = parsePatch(TWO_FILES);
  assert.equal(modified?.lines.find((line) => line.kind === 'context')?.oldLine, 1);
  assert.equal(modified?.lines.find((line) => line.kind === 'context')?.newLine, 1);
  assert.equal(modified?.lines.find((line) => line.kind === 'add')?.newLine, 2);
  assert.equal(modified?.lines.find((line) => line.kind === 'del')?.oldLine, 3);
  const [added] = parsePatch('diff --git a/new b/new\nnew file mode 100644\n@@ -0,0 +1 @@\n+new\n');
  assert.equal(added?.operation, 'added');
  assert.equal(added?.lines[1]?.newLine, 1);
  assert.equal(added?.lines[1]?.oldLine, undefined);
  const [deleted] = parsePatch(
    'diff --git a/gone b/gone\ndeleted file mode 100644\n@@ -1 +0,0 @@\n-old\n',
  );
  assert.equal(deleted?.operation, 'deleted');
  assert.equal(deleted?.lines[1]?.oldLine, 1);
  assert.equal(deleted?.lines[1]?.newLine, undefined);
  const [renamed] = parsePatch(
    'diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\n',
  );
  assert.equal(renamed?.operation, 'renamed');
  assert.equal(renamed?.oldPath, 'old name');
  assert.equal(renamed?.path, 'new name');
});

test('quoted path headers do not collapse several files into an unnamed diff', () => {
  const files = parsePatch(
    'diff --git "a/has\\tTab" "b/has\\tTab"\nnew file mode 100644\n@@ -0,0 +1 @@\n+x\ndiff --git a/plain b/plain\nnew file mode 100644\n',
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ['has\tTab', 'plain'],
  );
});

test('content starting with repeated plus or minus signs is not mistaken for a file header', () => {
  const [file] = parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n---old\n+++new\n');
  assert.equal(file?.removed, 1);
  assert.equal(file?.added, 1);
  assert.equal(file?.lines.at(-1)?.text, '++new');
});
