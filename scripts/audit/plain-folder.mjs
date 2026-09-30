/**
 * Audit P1 and P2: starting from a folder that is not in git.
 *
 *   npm run build:server && node scripts/audit/plain-folder.mjs
 *
 * Builds an ordinary JavaScript project that was never put under git — a
 * source file, a .env holding a (fake) key, and a node_modules of 20,000
 * files — adopts it, and reports what landed in the new repository in that
 * folder and in an experiment's folder. Then inspects the home folder and the
 * filesystem root, to show nothing refuses them.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';

import { startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-plain-'));
const project = join(root, 'my-app');
const du = (path) => `${execFileSync('du', ['-sm', path]).toString().split('\t')[0]} MB`;

await mkdir(join(project, 'src'), { recursive: true });
await writeFile(join(project, 'package.json'), '{ "name": "my-app" }\n');
await writeFile(join(project, 'src', 'index.js'), 'console.log("hi");\n');
await writeFile(join(project, '.env'), 'STRIPE_SECRET_KEY=sk_live_CANARY_123\n');
for (let p = 0; p < 200; p++) {
  const dir = join(project, 'node_modules', `pkg-${p}`, 'lib');
  await mkdir(dir, { recursive: true });
  for (let f = 0; f < 100; f++)
    await writeFile(join(dir, `f${f}.js`), `module.exports = ${p * 100 + f};\n`.repeat(40));
}

const bonsai = await startBonsai(join(root, 'data'));
try {
  const inspection = (await bonsai.api('POST', '/api/inspect', { path: project })).body;
  console.log(
    `folder: ${du(project)}, ${inspection.entryCount} top-level entries -> ` +
      `the page's size warning fires above 400: ${inspection.entryCount > 400}`,
  );

  let start = performance.now();
  const adopted = await bonsai.api('POST', '/api/projects/adopt', {
    path: project,
    description: '',
  });
  console.log(`adopted: HTTP ${adopted.status} in ${Math.round(performance.now() - start)} ms`);
  const tracked = execFileSync('git', ['ls-files'], { cwd: project }).toString().trim().split('\n');
  console.log(
    `committed into a new repository in your folder: ${tracked.length} files, ` +
      `${tracked.filter((f) => f.startsWith('node_modules/')).length} of them node_modules, ` +
      `.env included: ${tracked.includes('.env')}; .git is now ${du(join(project, '.git'))}`,
  );

  const child = (
    await bonsai.api('POST', `/api/projects/${adopted.body.projectId}/nodes`, {
      parentId: adopted.body.masterNodeId,
      displayName: 'try',
      description: '',
    })
  ).body.node;
  start = performance.now();
  await bonsai.api('POST', `/api/nodes/${child.id}/runs`, { prompt: 'go' });
  await bonsai.settle(child.id);
  const folder = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: project })
    .toString()
    .split('\n')
    .find((line) => line.startsWith('worktree ') && line.includes(child.id))
    .slice('worktree '.length);
  console.log(
    `an experiment's first run: ${Math.round(performance.now() - start)} ms; its folder: ${du(folder)}`,
  );

  for (const path of [homedir(), parse(homedir()).root]) {
    const found = (await bonsai.api('POST', '/api/inspect', { path })).body;
    console.log(
      `${path}: blocked: ${found.blockedReason ?? 'no'}; ${found.entryCount} top-level entries, ` +
        `size warning: ${found.entryCount > 400}`,
    );
  }
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
