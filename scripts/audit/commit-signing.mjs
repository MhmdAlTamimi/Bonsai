/**
 * Audit P5: commit signing turned on in the user's global git config.
 *
 *   npm run build:server && node scripts/audit/commit-signing.mjs
 *
 * Runs Bonsai with a home folder whose ~/.gitconfig has
 * `commit.gpgsign = true` and a key that is not there, then (1) runs a
 * stand-in experiment in a project Bonsai creates, and (2) adopts a folder
 * that is not in git.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-signing-'));
await writeFile(
  join(root, '.gitconfig'),
  '[commit]\n\tgpgsign = true\n[user]\n\tsigningkey = DEADBEEF\n',
);
const plain = join(root, 'notes');
await mkdir(plain);
await writeFile(join(plain, 'todo.txt'), 'hello\n');

const bonsai = await startBonsai(join(root, 'data'), { HOME: root });
try {
  const created = (await bonsai.api('POST', '/api/projects', { name: 'signed', description: '' }))
    .body;
  await bonsai.api('POST', `/api/nodes/${created.masterNodeId}/runs`, { prompt: 'go' });
  const run = (await bonsai.settle(created.masterNodeId)).body;
  console.log(`a run: ${run.node.status} - ${(run.runs.at(-1).error ?? '').split('\n')[0]}`);

  const adopted = await bonsai.api('POST', '/api/projects/adopt', { path: plain, description: '' });
  console.log(
    `adopting a folder not in git: HTTP ${adopted.status} ${JSON.stringify(adopted.body).slice(0, 120)}`,
  );
  console.log(`left in that folder: ${(await readdir(plain)).join(', ')}`);
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
