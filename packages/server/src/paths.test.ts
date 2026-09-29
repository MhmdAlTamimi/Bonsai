import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';

import { isInside, samePath } from './paths.js';

/**
 * Folder comparisons, under both platforms' rules whatever runs the tests: a
 * text comparison passes on Linux and is wrong on Windows, which CI would
 * otherwise never see.
 */
describe('comparing folders', () => {
  test('Linux: inside means below, not a longer name', () => {
    assert.equal(isInside('/home/me/repo', '/home/me/repo', posix), true);
    assert.equal(isInside('/home/me/repo', '/home/me/repo/src/app', posix), true);
    assert.equal(isInside('/home/me/repo', '/home/me/repository', posix), false);
    assert.equal(isInside('/home/me/repo', '/home/me', posix), false);
    assert.equal(isInside('/home/me/repo', '/home/me/repo/../other', posix), false);
    assert.equal(isInside('/home/me/repo/', '/home/me/repo/..data', posix), true);
    // Case matters on Linux.
    assert.equal(samePath('/home/me/Repo', '/home/me/repo', posix), false);
  });

  test('Windows: backslashes, git’s forward slashes, any case, other drives', () => {
    const repo = 'C:\\Users\\me\\repo';
    assert.equal(isInside(repo, 'C:\\Users\\me\\repo\\src', win32), true);
    // The separator the text comparison looked for was never there.
    assert.equal(isInside(repo, 'C:\\Users\\me\\repo\\.bonsai\\worktrees', win32), true);
    // git rev-parse writes C:/Users/...; it is the same folder.
    assert.equal(isInside(repo, 'C:/Users/me/repo/src', win32), true);
    assert.equal(samePath(repo, 'C:/Users/me/repo', win32), true);
    // Windows names ignore case, drive letters included.
    assert.equal(samePath(repo, 'c:\\users\\ME\\Repo', win32), true);
    assert.equal(isInside('c:\\users\\me', repo, win32), true);
    assert.equal(isInside(repo, 'C:\\Users\\me\\repository', win32), false);
    assert.equal(isInside(repo, 'D:\\Users\\me\\repo\\src', win32), false);
    assert.equal(samePath(repo, 'D:\\Users\\me\\repo', win32), false);
    assert.equal(isInside('D:\\', 'D:\\projects', win32), true);
  });
});
