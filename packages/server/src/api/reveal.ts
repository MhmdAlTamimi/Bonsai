import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Opening a folder in the platform's file manager.
 *
 * DETACHED, AND NOT WAITED FOR. That is the whole of it, and getting it wrong
 * produced a failure message for an operation that had succeeded.
 *
 * The previous version ran the opener through `execFile` with a ten-second
 * timeout and treated any non-zero result as a failure. A file manager does not
 * exit when it has finished opening a window; it exits when the user closes it.
 * Where `xdg-open` execs the manager rather than forking away from it -- GNOME
 * Files under Hyprland, for one -- the call therefore sat there until the
 * timeout killed it, and Bonsai reported "could not open this folder" ten
 * seconds after the folder had appeared on screen.
 *
 * So the only failures worth reporting are the ones that are knowable quickly:
 * the opener is not installed, or it refused outright. Anything still running
 * after a moment has done its job, and Bonsai lets go of it.
 */

/**
 * How long to watch before assuming the opener is doing its job.
 *
 * Long enough for "command not found" and an immediate refusal to land --
 * both are a fork/exec away -- and short enough that the button never feels
 * like it is thinking.
 */
const GRACE_MS = 800;

/**
 * Starts a detached process and reports only what goes wrong immediately.
 *
 * Exported for its tests: the case that matters is a process that does NOT
 * exit, which must read as success.
 */
export async function launchDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise<void>((resolveLaunch, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolveLaunch();
      else reject(error);
    };

    const child = spawn(command, [...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Released straight away: the file manager outlives this request, and
    // holding a handle to it would keep Bonsai's event loop referencing a
    // process it has no further interest in.
    child.unref();

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        new Error(
          err.code === 'ENOENT'
            ? `${command} is not installed, so Bonsai has no way to open a folder for you.`
            : `${command} could not be started: ${err.message}`,
        ),
      );
    });

    child.on('exit', (code) => {
      /**
       * Windows Explorer exits 1 on success. It is documented, long-standing,
       * and would otherwise make every reveal on Windows report a failure --
       * the same mistake as waiting for a process that never exits, in a
       * different disguise.
       */
      if (process.platform === 'win32' || code === 0 || code === null) finish();
      else finish(new Error(`${command} exited with code ${code}.`));
    });

    /**
     * NOT unref'd, deliberately. The child is -- it has to outlive us -- and if
     * this timer were too, a process with nothing else pending would exit
     * before the promise settled and the caller would wait forever. There is
     * always an HTTP request waiting on this, and 800ms is how long it waits.
     */
    const timer = setTimeout(() => finish(), GRACE_MS);
  });
}

/** Opens a folder in the platform's file manager. */
export async function revealInFileManager(path: string): Promise<void> {
  const target = resolve(path);
  /**
   * Checked before the desktop is blamed for it. A project folder that has
   * been moved or deleted outside Bonsai is a different problem with a
   * different answer, and "could not open this folder" for a folder that is
   * not there sent people looking at their file manager.
   */
  if (!existsSync(target)) {
    throw new Error(`That folder is not on disk any more: ${target}`);
  }

  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';

  try {
    await launchDetached(command, [target]);
  } catch (error) {
    // The reason, not a shrug. This used to throw away the only sentence that
    // explained anything, which is why the failure was unfindable: the message
    // is deliberately kept out of the diagnostics report, so a generic string
    // here left nothing anywhere.
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} ` +
        `Copy the path and open it yourself: ${target}`,
    );
  }
}
