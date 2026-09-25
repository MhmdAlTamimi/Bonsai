import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  folderOpener,
  launchDetached,
  OPENER_SPAWN_OPTIONS,
  revealInFileManager,
} from './reveal.js';

/**
 * Opening a folder, and the failure that was not one.
 *
 * Bonsai used to run the opener with a ten-second timeout and call any
 * non-zero result a failure. A file manager exits when the user closes its
 * window, not when it has finished opening one, so on a desktop where
 * `xdg-open` execs the manager instead of forking away from it the call hung
 * until the timeout killed it -- and Bonsai said "could not open this folder"
 * ten seconds after the folder had appeared on screen.
 *
 * The first test below is that bug, in the smallest form that still has it: a
 * process that does not exit has to read as success, and it has to say so
 * promptly.
 */
// These use POSIX `sleep` and `false`, which Windows does not have.
const windows = process.platform === 'win32';

describe('opening a folder in the file manager', () => {
  test('an opener that keeps running has succeeded', { skip: windows }, async () => {
    const started = Date.now();
    // `sleep 30` is a file manager as far as this is concerned: started fine,
    // still running, no intention of exiting.
    await launchDetached('sleep', ['30']);
    assert.ok(
      Date.now() - started < 5000,
      'a long-running opener must not hold the request open waiting for it',
    );
  });

  test('an opener that is not installed says so, by name', async () => {
    await assert.rejects(
      () => launchDetached('bonsai-no-such-opener', ['/tmp']),
      /bonsai-no-such-opener is not installed/,
    );
  });

  test(
    'an opener that refuses outright is reported, with its exit code',
    { skip: windows },
    async () => {
      await assert.rejects(() => launchDetached('false', []), /exited with code 1/);
    },
  );

  test('the window it opens is visible, on Windows too', () => {
    // windowsHide starts a GUI program with SW_HIDE: Explorer opened the
    // folder in a window nobody could see, and Bonsai reported success.
    assert.equal(OPENER_SPAWN_OPTIONS.windowsHide, false);
    assert.equal(OPENER_SPAWN_OPTIONS.detached, true);
    assert.equal(folderOpener('win32'), 'explorer.exe');
    assert.equal(folderOpener('darwin'), 'open');
    assert.equal(folderOpener('linux'), 'xdg-open');
  });

  test('a folder that is gone is named as the problem, not the desktop', async () => {
    const missing = join(tmpdir(), 'bonsai-not-here-9e1f7a');
    await assert.rejects(
      () => revealInFileManager(missing),
      (error: Error) => {
        assert.match(error.message, /not on disk/);
        assert.ok(error.message.includes(missing), 'the path is in the message');
        return true;
      },
    );
  });
});
