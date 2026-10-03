/**
 * Audit phase 12: how long Review takes in a larger repository when the
 * experiment has uncommitted work — a run still going, a stopped run, or
 * "Leave uncommitted".
 *
 *   npm run build:server && node scripts/audit/review-cost.mjs
 *
 * A folder of yours with 40,000 files; one experiment; the same Review
 * requests timed with the experiment's work committed, then with one file
 * changed and not yet committed.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { gitEnv, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-reviewcost-'));
const repo = join(root, 'big');
await mkdir(repo);
const git = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv, maxBuffer: 1e9 });
git('init', '-q', '--initial-branch=main');
for (let d = 0; d < 400; d++) {
  await mkdir(join(repo, `pkg${d}`));
  for (let f = 0; f < 100; f++)
    await writeFile(join(repo, `pkg${d}`, `f${f}.ts`), `export const v${f} = ${d};\n`.repeat(250));
}
git('add', '-A');
git('commit', '-qm', 'big');

const bonsai = await startBonsai(join(root, 'data'));
const time = async (label, path) => {
  const started = performance.now();
  const res = await bonsai.api('GET', path);
  console.log(`  ${label}: ${Math.round(performance.now() - started)} ms (HTTP ${res.status})`);
  return res.body;
};
try {
  const project = (await bonsai.api('POST', '/api/projects/adopt', { path: repo, description: '' }))
    .body;
  const id = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'change one thing',
      description: '',
    })
  ).body.node.id;
  await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'change one thing' });
  await bonsai.settle(id);
  const db = new DatabaseSync(join(root, 'data', 'bonsai.db'), { readOnly: true });
  const folder = db.prepare('SELECT worktree_path FROM node WHERE id = ?').get(id).worktree_path;
  db.close();

  console.log('everything committed:');
  let list = await time('open Review (the file list)', `/api/nodes/${id}/review`);
  const file = encodeURIComponent(list.files[0].path);
  await time('open one file', `/api/nodes/${id}/review/file?path=${file}`);

  await writeFile(join(folder, 'pkg0', 'f0.ts'), 'changed, not committed yet\n');
  console.log('one file changed and not yet committed:');
  list = await time('open Review (the file list)', `/api/nodes/${id}/review`);
  await time('open one file', `/api/nodes/${id}/review/file?path=${file}`);
  await time(
    'open another',
    `/api/nodes/${id}/review/file?path=${encodeURIComponent('pkg0/f0.ts')}`,
  );
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
