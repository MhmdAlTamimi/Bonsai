/**
 * Audit phase 13: what a comparison costs in time and disk.
 *
 *   npm run build:server && node scripts/audit/compare-cost.mjs [files] [bytes-per-file]
 *
 * A folder of yours (default 20,000 files of 2 KB, about 40 MB of code) and
 * three experiments of it. Times creating a comparison of all three — the
 * request waits for it — measures what it leaves on disk, then times Update.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitEnv, startBonsai } from './lib.mjs';

const count = Number(process.argv[2] ?? 20000);
const size = Number(process.argv[3] ?? 2048);
const root = await mkdtemp(join(tmpdir(), 'bonsai-comparecost-'));
const repo = join(root, 'code');
await mkdir(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv, maxBuffer: 1e9 });
git('init', '-q', '--initial-branch=main');
for (let d = 0; d < count / 100; d++) {
  await mkdir(join(repo, `pkg${d}`));
  for (let f = 0; f < 100; f++)
    await writeFile(join(repo, `pkg${d}`, `f${f}.ts`), `// ${d}/${f}\n`.padEnd(size, 'x'));
}
git('add', '-A');
git('commit', '-qm', 'code');
const du = (path) => execFileSync('du', ['-sm', path]).toString().split('\t')[0];

const bonsai = await startBonsai(join(root, 'data'));
try {
  const project = (await bonsai.api('POST', '/api/projects/adopt', { path: repo, description: '' }))
    .body;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const id = (
      await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: `approach ${i + 1}`,
        description: '',
      })
    ).body.node.id;
    await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `approach ${i + 1}` });
    await bonsai.settle(id);
    ids.push(id);
  }
  console.log(`your folder: ${count} files, ${du(join(repo))} MB`);
  let started = performance.now();
  const made = await bonsai.api('POST', `/api/projects/${project.projectId}/comparisons`, {
    nodeIds: ids,
  });
  console.log(
    `create a comparison of 3: HTTP ${made.status} after ${Math.round(performance.now() - started)} ms`,
  );
  const compareDir = execFileSync('find', [join(root, 'data'), '-type', 'd', '-name', 'compare'])
    .toString()
    .trim();
  console.log(`  on disk afterwards: ${du(compareDir)} MB in ${compareDir.replace(root, '…')}`);
  await bonsai.api('POST', `/api/nodes/${ids[0]}/runs`, { prompt: 'move on' });
  await bonsai.settle(ids[0]);
  started = performance.now();
  const updated = await bonsai.api('POST', `/api/comparisons/${made.body.id}/refresh`);
  console.log(
    `Update after one experiment moved on: HTTP ${updated.status} after ${Math.round(performance.now() - started)} ms`,
  );
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
