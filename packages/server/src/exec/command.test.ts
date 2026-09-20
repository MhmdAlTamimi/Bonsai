import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from './command.js';

test('pre-cancelled commands never start', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCommand({ command: 'exit 0', cwd: tmpdir(), signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
});

test(
  'Stop escalates to kill a shell and its TERM-resistant descendants',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'bonsai-command-'));
    const controller = new AbortController();
    try {
      const result = runCommand({
        command: 'sh -c \'trap "" TERM; echo $$ > child.pid; while :; do sleep 1; done\'',
        cwd: root,
        signal: controller.signal,
      });
      let pid = 0;
      for (let i = 0; i < 200 && !pid; i++) {
        try {
          pid = Number(await readFile(join(root, 'child.pid'), 'utf8'));
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      assert.ok(pid);
      controller.abort();
      assert.equal((await result).ok, false);
      // On Linux an orphan may briefly be a zombie; it must no longer execute.
      if (process.platform === 'linux') {
        let running = true;
        for (let i = 0; i < 100 && running; i++) {
          try {
            running = !(await readFile(`/proc/${pid}/stat`, 'utf8')).includes(') Z ');
          } catch {
            running = false;
          }
          if (running) await new Promise((r) => setTimeout(r, 10));
        }
        assert.equal(running, false);
      } else assert.throws(() => process.kill(pid, 0));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
