/**
 * Audit phase 6: move Bonsai's data folder somewhere else — a new computer,
 * a new user name, another drive — and try what a person would do next.
 *
 *   npm run build:server && node scripts/audit/move-data.mjs
 *
 * Builds, under one "home" folder: a project Bonsai created with three
 * experiments (one with a child, one archived), and a project added from a
 * folder of your own with one experiment. Stops Bonsai, renames the home
 * folder (what copying it to a machine with another user name amounts to),
 * starts Bonsai on the moved data folder, and reports each step.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { gitEnv, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-move-'));
const oldHome = join(root, 'alice');
const newHome = join(root, 'alice-laptop');
const code = join(oldHome, 'code', 'my-app');
await mkdir(code, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: code, env: gitEnv });
git('init', '-q', '--initial-branch=main');
await writeFile(join(code, 'app.txt'), 'one\n');
git('add', '-A');
git('commit', '-qm', 'first');

const short = (body) => JSON.stringify(body).slice(0, 150);
const show = (label, res) =>
  console.log(`  ${label}: HTTP ${res.status}${res.status >= 400 ? ` ${short(res.body)}` : ''}`);

let bonsai = await startBonsai(join(oldHome, 'data'));
try {
  const make = async (projectId, parentId, name) => {
    const node = (
      await bonsai.api('POST', `/api/projects/${projectId}/nodes`, {
        parentId,
        displayName: name,
        description: '',
      })
    ).body.node;
    await bonsai.api('POST', `/api/nodes/${node.id}/runs`, { prompt: name });
    await bonsai.settle(node.id);
    return node.id;
  };
  const created = (await bonsai.api('POST', '/api/projects', { name: 'made', description: '' }))
    .body;
  const a = await make(created.projectId, created.masterNodeId, 'a');
  const child = await make(created.projectId, a, 'a child');
  const archived = await make(created.projectId, created.masterNodeId, 'archived');
  show('archive one', await bonsai.api('POST', `/api/nodes/${archived}/archive`, {}));
  const adopted = (await bonsai.api('POST', '/api/projects/adopt', { path: code, description: '' }))
    .body;
  const mine = await make(adopted.projectId, adopted.masterNodeId, 'mine');
  await bonsai.stop();

  await rename(oldHome, newHome);
  console.log(`moved ${oldHome} -> ${newHome}`);
  const dataDir = join(newHome, 'data');
  const db = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
  const stale = db
    .prepare(
      `SELECT (SELECT count(*) FROM project WHERE repo_path LIKE ? OR scratch_path LIKE ? OR source_path LIKE ?)
            + (SELECT count(*) FROM node WHERE worktree_path LIKE ?) AS n`,
    )
    .get(...Array(4).fill(`${oldHome}%`)).n;
  db.close();
  console.log(`  paths in the database still under the old location: ${stale}`);
  const settings = await readFile(join(dataDir, 'settings.json'), 'utf8').catch(() => '');
  console.log(`  settings.json mentions the old location: ${settings.includes(oldHome)}`);

  bonsai = await startBonsai(dataDir);
  console.log('Bonsai started on the moved data folder');
  show('list projects', await bonsai.api('GET', '/api/projects'));
  show(
    'open the project Bonsai made',
    await bonsai.api('GET', `/api/projects/${created.projectId}/tree`),
  );
  show('open experiment "a"', await bonsai.api('GET', `/api/nodes/${a}`));
  show('review "a"', await bonsai.api('GET', `/api/nodes/${a}/review`));
  show('apply "a" (make its patch)', await bonsai.api('POST', `/api/nodes/${a}/patch`, {}));
  await bonsai.api('POST', `/api/nodes/${child}/runs`, { prompt: 'carry on' });
  const run = (await bonsai.settle(child)).body;
  console.log(
    `  run "a child" again: ${run?.node?.status ?? short(run)} ${(run?.runs?.at(-1)?.error ?? '').split('\n')[0].slice(0, 140)}`,
  );
  await bonsai.api('POST', `/api/nodes/${archived}/runs`, { prompt: 'bring it back' });
  const back = (await bonsai.settle(archived)).body;
  console.log(
    `  run the archived one: ${back?.node?.status ?? short(back)} ${(back?.runs?.at(-1)?.error ?? '').split('\n')[0].slice(0, 140)}`,
  );
  show(
    'branch from "a"',
    await bonsai.api('POST', `/api/projects/${created.projectId}/nodes`, {
      parentId: a,
      displayName: 'new',
      description: '',
    }),
  );
  show(
    'open the project from your folder',
    await bonsai.api('GET', `/api/projects/${adopted.projectId}/tree`),
  );
  show('open its experiment', await bonsai.api('GET', `/api/nodes/${mine}`));
  show(
    'delete the project Bonsai made',
    await bonsai.api('DELETE', `/api/projects/${created.projectId}`),
  );
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
