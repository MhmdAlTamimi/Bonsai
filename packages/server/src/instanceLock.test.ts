import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { acquireInstanceLock, AlreadyRunningError } from './instanceLock.js';

test('a competing process is refused, and SIGKILL releases the data-folder lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bonsai-instance-'));
  const script = `import { acquireInstanceLock } from ${JSON.stringify(new URL('./instanceLock.js', import.meta.url).href)};
    acquireInstanceLock(${JSON.stringify(dir)}, 8787);
    process.stdout.write('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('lock holder did not start')), 10000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`lock holder exited ${code}`));
      });
    });
    assert.throws(
      () => acquireInstanceLock(dir, 9999),
      (error: unknown) =>
        error instanceof AlreadyRunningError && error.url === 'http://localhost:8787',
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const release = acquireInstanceLock(dir, 9999);
    release();
    acquireInstanceLock(dir, 9998)();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
