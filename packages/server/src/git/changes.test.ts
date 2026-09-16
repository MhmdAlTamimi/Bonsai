import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { git, gitLine } from './exec.js';
import {
  committedChanges,
  committedFilePatch,
  parseNameStatus,
  parseNumstat,
  uncommittedChanges,
  uncommittedFilePatch,
} from './changes.js';

/**
 * Change summaries against real git: the paths people actually have -- spaces,
 * accents, renames, binaries, files git is not tracking yet -- are exactly
 * where a hand-rolled parser goes quietly wrong.
 */
describe('what changed, file by file', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'bonsai-changes-'));
    await git(['init', '--initial-branch=main', '.'], repo);
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function put(files: Record<string, string | Buffer>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
  }
  async function commit(message: string): Promise<string> {
    await git(['add', '-A'], repo);
    await git(['commit', '-m', message], repo);
    return gitLine(['rev-parse', 'HEAD'], repo);
  }

  test('statuses, counts, renames, binaries and awkward paths', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await put({
      'src/app.py': 'print(1)\n',
      'src/old name.py': long,
      'gone.txt': 'bye\n',
    });
    const base = await commit('base');

    await put({
      'src/app.py': 'print(2)\nprint(3)\n',
      'data/résumé données.csv': 'a,b\n1,2\n',
      'model.bin': Buffer.from([0, 1, 2, 3, 0, 255]),
      'CONTEXT.md': '# notes\n',
    });
    await git(['mv', 'src/old name.py', 'src/new name.py'], repo);
    await unlink(join(repo, 'gone.txt'));
    const head = await commit('work');

    const files = await committedChanges(repo, base, head);
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.deepEqual(
      files.map((f) => f.path),
      [
        'CONTEXT.md',
        'data/résumé données.csv',
        'gone.txt',
        'model.bin',
        'src/app.py',
        'src/new name.py',
      ],
    );
    assert.deepEqual(byPath.get('src/app.py'), {
      path: 'src/app.py',
      status: 'modified',
      added: 2,
      removed: 1,
      binary: false,
      notes: false,
    });
    assert.equal(byPath.get('data/résumé données.csv')?.status, 'added');
    assert.equal(byPath.get('data/résumé données.csv')?.added, 2);
    assert.equal(byPath.get('gone.txt')?.status, 'deleted');
    assert.equal(byPath.get('model.bin')?.binary, true);
    assert.equal(byPath.get('CONTEXT.md')?.notes, true);
    const renamed = byPath.get('src/new name.py')!;
    assert.equal(renamed.status, 'renamed');
    assert.equal(renamed.oldPath, 'src/old name.py');

    // A file's own patch, and only that file.
    const patch = (await committedFilePatch(repo, base, head, byPath.get('src/app.py')!)).patch;
    assert.match(patch, /\+print\(3\)/);
    assert.doesNotMatch(patch, /résumé/);
    // A rename's patch is a rename, not a deletion and an addition.
    const renamePatch = (await committedFilePatch(repo, base, head, renamed)).patch;
    assert.match(renamePatch, /rename from src\/old name\.py/);
  });

  test('uncommitted work includes untracked files, with their lines counted', async () => {
    await put({ 'keep.py': 'a\n', 'drop.py': 'b\n' });
    await commit('base');

    await put({
      'keep.py': 'a\nb\n',
      'out/résultats 1.csv': 'x\ny\nz',
      'weights.bin': Buffer.from([0, 0, 1]),
    });
    await unlink(join(repo, 'drop.py'));

    const files = await uncommittedChanges(repo);
    const byPath = new Map(files.map((f) => [f.path, f]));
    assert.equal(byPath.get('keep.py')?.status, 'modified');
    assert.equal(byPath.get('keep.py')?.added, 1);
    assert.equal(byPath.get('drop.py')?.status, 'deleted');
    const results = byPath.get('out/résultats 1.csv')!;
    assert.equal(results.status, 'added');
    assert.equal(results.untracked, true);
    assert.equal(results.added, 3, 'a last line without a newline still counts');
    assert.equal(byPath.get('weights.bin')?.binary, true);

    // An untracked file has a patch too, against nothing.
    const patch = (await uncommittedFilePatch(repo, results)).patch;
    assert.match(patch, /\+x\n\+y\n\+z/);
    const tracked = (await uncommittedFilePatch(repo, byPath.get('keep.py')!)).patch;
    assert.match(tracked, /\+b/);
  });

  test('nothing changed is an empty list, not an error', async () => {
    await put({ 'a.txt': 'a\n' });
    const head = await commit('base');
    assert.deepEqual(await committedChanges(repo, head, head), []);
    assert.deepEqual(await uncommittedChanges(repo), []);
  });
});

describe('reading git’s NUL-separated output', () => {
  test('name-status with a rename in the middle', () => {
    assert.deepEqual(parseNameStatus('M\0a.py\0R087\0old.py\0new.py\0D\0z.py\0'), [
      { path: 'a.py', status: 'modified' },
      { path: 'new.py', oldPath: 'old.py', status: 'renamed' },
      { path: 'z.py', status: 'deleted' },
    ]);
  });

  test('numstat with a binary and a rename, keyed by where the file ends up', () => {
    const counts = parseNumstat('3\t1\ta.py\0-\t-\tm.bin\0' + '2\t0\t\0old.py\0new.py\0');
    assert.deepEqual(counts.get('a.py'), { added: 3, removed: 1, binary: false });
    assert.deepEqual(counts.get('m.bin'), { added: 0, removed: 0, binary: true });
    assert.deepEqual(counts.get('new.py'), { added: 2, removed: 0, binary: false });
    assert.equal(counts.has('old.py'), false);
  });
});
