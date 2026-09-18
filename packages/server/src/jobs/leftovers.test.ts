import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { RUN_MARKER, findLeftovers, roots, stopLeftovers } from './leftovers.js';

/**
 * D43: finding work a run detached, by the marker it inherited.
 *
 * Real processes, because the rule is about how the OS re-parents them: a
 * process started with `… &` from a shell that then exits leaves the agent's
 * process tree, while the harness's own tracked jobs stay inside it. Linux
 * only; macOS uses `ps` and is not exercised here.
 */
const linuxOnly = { skip: process.platform !== 'linux' };

const runs: string[] = [];
afterEach(async () => {
  for (const runId of runs.splice(0)) await stopLeftovers(runId, 500);
});

/** Starts `command` the way `nohup … &` does: from a shell that exits at once. */
function detach(command: string, runId: string | null): void {
  const env = { ...process.env };
  if (runId !== null) env[RUN_MARKER] = runId;
  const shell = spawn('sh', ['-c', `${command} &`], { env, stdio: 'ignore', detached: true });
  shell.unref();
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 50 && !done(value); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    value = await read();
  }
  return value;
}

describe('work a run left running', () => {
  test('a process detached with the run’s marker is found', linuxOnly, async () => {
    const runId = randomUUID();
    runs.push(runId);
    detach('sleep 37', runId);

    const found = await until(
      () => findLeftovers(runId),
      (list) => list.length > 0,
    );
    assert.equal(found.length, 1);
    assert.match(found[0]!.command, /sleep 37/);
  });

  test('a process still inside our own tree is not a leftover', linuxOnly, async () => {
    const runId = randomUUID();
    // What the harness and its tracked jobs look like: marked, but ours.
    const child = spawn('sleep', ['38'], {
      env: { ...process.env, [RUN_MARKER]: runId },
      stdio: 'ignore',
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(await findLeftovers(runId), []);
    } finally {
      child.kill();
    }
  });

  test(
    'another run’s detached process, or an unmarked one, is not this run’s',
    linuxOnly,
    async () => {
      const runId = randomUUID();
      const other = randomUUID();
      runs.push(other);
      detach('sleep 39', other);
      detach('sleep 40', null);

      await until(
        () => findLeftovers(other),
        (list) => list.length > 0,
      );
      assert.deepEqual(await findLeftovers(runId), []);
      // The unmarked one is nobody's to stop.
      await stopLeftovers(other, 500);
      execFileSync('pkill', ['-f', '^sleep 40$']);
    },
  );

  test('stopping them ends every one, and names each piece of work once', linuxOnly, async () => {
    const runId = randomUUID();
    runs.push(runId);
    // A shell that stays alive running a child: two processes, one piece of work.
    detach('sh -c "sleep 41; true"', runId);
    await until(
      () => findLeftovers(runId),
      (list) => list.length >= 2,
    );

    const stopped = await stopLeftovers(runId, 1_000);
    assert.equal(stopped.length, 1);
    assert.match(stopped[0]!.command, /sh -c sleep 41; true/);
    assert.deepEqual(await findLeftovers(runId), []);
  });
});

describe('naming work by its root process', () => {
  test('a child of another leftover is part of that one’s work', () => {
    assert.deepEqual(
      roots([
        { pid: 10, ppid: 1, command: 'uv run python train.py' },
        { pid: 11, ppid: 10, command: 'python train.py' },
        { pid: 20, ppid: 1, command: 'tensorboard --logdir runs' },
      ]).map((p) => p.pid),
      [10, 20],
    );
  });
});
