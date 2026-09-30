/**
 * Audit P4: what "Include my unsaved changes" costs in a larger repository.
 *
 *   npm run build:server && node scripts/audit/snapshot-cost.mjs
 *
 * 40,000 files, one of them changed. Compares git status, Bonsai's snapshot
 * as written (a fresh index from HEAD, then add -A) and the same snapshot
 * started from a copy of the real index.
 */
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { gitEnv, repoRoot } from './lib.mjs';

const dist = (path) => pathToFileURL(join(repoRoot, 'packages/server/dist', path)).href;
const { snapshotUncommitted } = await import(dist('git/adopt.js'));
const { git } = await import(dist('git/exec.js'));

const repo = await mkdtemp(join(tmpdir(), 'bonsai-snapshot-'));
const run = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv, maxBuffer: 1e9 });
try {
  run('init', '-q');
  for (let d = 0; d < 400; d++) {
    await mkdir(join(repo, `pkg${d}`));
    for (let f = 0; f < 100; f++)
      await writeFile(
        join(repo, `pkg${d}`, `f${f}.ts`),
        `export const v${f} = ${d};\n`.repeat(250),
      );
  }
  run('add', '-A');
  run('commit', '-qm', 'big');
  await writeFile(join(repo, 'pkg0', 'f0.ts'), 'changed\n');

  let start = performance.now();
  run('status', '--porcelain');
  console.log(`git status: ${Math.round(performance.now() - start)} ms`);

  start = performance.now();
  await snapshotUncommitted(repo);
  console.log(`snapshot as written: ${Math.round(performance.now() - start)} ms`);

  start = performance.now();
  const scratch = await mkdtemp(join(tmpdir(), 'bonsai-index-'));
  await copyFile(join(repo, '.git', 'index'), join(scratch, 'index'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  await git(['add', '-A', '--', '.'], repo, env);
  await git(['write-tree'], repo, env);
  await rm(scratch, { recursive: true, force: true });
  console.log(
    `snapshot from a copy of the real index: ${Math.round(performance.now() - start)} ms`,
  );
} finally {
  await rm(repo, { recursive: true, force: true });
}
