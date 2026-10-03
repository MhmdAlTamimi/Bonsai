/**
 * Audit phase 12: taking a created project's code out by copying the
 * experiment's folder — the folder Review's "Open experiment folder" shows —
 * and then using git in the copy, as anyone would.
 *
 *   npm run build:server && node scripts/audit/copied-folder.mjs
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { gitEnv, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-copied-'));
const bonsai = await startBonsai(join(root, 'data'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: gitEnv }).toString().trim();
try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'mine', description: '' }))
    .body;
  const id = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'the one I want',
      description: '',
    })
  ).body.node.id;
  await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'make it' });
  await bonsai.settle(id);
  const db = new DatabaseSync(join(root, 'data', 'bonsai.db'), { readOnly: true });
  const folder = db.prepare('SELECT worktree_path FROM node WHERE id = ?').get(id).worktree_path;
  db.close();

  const copy = join(root, 'my-code');
  await cp(folder, copy, { recursive: true });
  console.log(`the copy's .git is: ${(await readFile(join(copy, '.git'), 'utf8')).trim()}`);
  await writeFile(join(copy, 'mine.txt'), 'my own work in my copy\n');
  git(copy, 'add', '-A');
  git(copy, 'commit', '-qm', 'my work, in my copy');
  console.log('committed in the copy');
  console.log(`the experiment's own folder now shows: ${git(folder, 'log', '--oneline', '-1')}`);

  await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'carry on' });
  const after = (await bonsai.settle(id)).body;
  console.log(
    `next run in Bonsai: ${after.node.status} ${(after.runs.at(-1)?.error ?? '').split('\n')[0].slice(0, 120)}`,
  );
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
