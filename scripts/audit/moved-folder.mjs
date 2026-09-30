/**
 * Audit P3: a project whose folder is moved or renamed.
 *
 *   npm run build:server && node scripts/audit/moved-folder.mjs
 *
 * Adopts a repository, runs an experiment, then renames the folder above it
 * (`projects` -> `Projects`) and tries what a person would do next.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitEnv, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-moved-'));
const repo = join(root, 'projects', 'my-app');
await mkdir(repo, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, env: gitEnv });
git('init', '-q', '--initial-branch=main');
await writeFile(join(repo, 'app.txt'), 'one\n');
git('add', '-A');
git('commit', '-qm', 'first');

const bonsai = await startBonsai(join(root, 'data'));
const show = (label, res) =>
  console.log(
    `${label}: HTTP ${res.status}${res.status >= 400 ? ` ${JSON.stringify(res.body)}` : ''}`,
  );
try {
  const project = (await bonsai.api('POST', '/api/projects/adopt', { path: repo, description: '' }))
    .body;
  const child = (
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'try',
      description: '',
    })
  ).body.node;
  await bonsai.api('POST', `/api/nodes/${child.id}/runs`, { prompt: 'first' });
  console.log(
    `before the move, the experiment is: ${(await bonsai.settle(child.id)).body.node.status}`,
  );

  await rename(join(root, 'projects'), join(root, 'Projects'));
  console.log('renamed projects/ to Projects/');

  show('open the project', await bonsai.api('GET', `/api/projects/${project.projectId}/tree`));
  show('open the experiment', await bonsai.api('GET', `/api/nodes/${child.id}`));
  show('review it', await bonsai.api('GET', `/api/nodes/${child.id}/review`));
  show(
    'branch a new experiment',
    await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
      parentId: project.masterNodeId,
      displayName: 'another',
      description: '',
    }),
  );
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
