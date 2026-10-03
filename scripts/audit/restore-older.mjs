/**
 * Audit phase 6: put back a database older than the repositories — what
 * restoring Bonsai's own pre-upgrade backup does, or a backup of the database
 * file alone.
 *
 *   npm run build:server && node scripts/audit/restore-older.mjs
 *
 * Takes a consistent copy of the database (VACUUM INTO), carries on working —
 * runs an existing experiment again, makes a new one — then stops Bonsai,
 * puts the copy back and starts it, and reports what each experiment shows.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-restore-'));
const dataDir = join(root, 'data');
const file = join(dataDir, 'bonsai.db');
const short = (body) => JSON.stringify(body).slice(0, 160);
const lastError = (detail) => (detail?.runs?.at(-1)?.error ?? '').split('\n')[0].slice(0, 160);

let bonsai = await startBonsai(dataDir);
try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'restore', description: '' }))
    .body;
  const make = async (name) => {
    const node = (
      await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: name,
        description: '',
      })
    ).body.node;
    await bonsai.api('POST', `/api/nodes/${node.id}/runs`, { prompt: name });
    await bonsai.settle(node.id);
    return node.id;
  };
  const untouched = await make('untouched since the backup');
  const ranAgain = await make('ran again after the backup');

  const backup = join(root, 'bonsai.db.backup');
  const live = new DatabaseSync(file);
  live.prepare('VACUUM INTO ?').run(backup);
  live.close();
  console.log('backed up the database');

  await bonsai.api('POST', `/api/nodes/${ranAgain}/runs`, { prompt: 'after the backup' });
  await bonsai.settle(ranAgain);
  const madeAfter = await make('made after the backup');
  const peek = new DatabaseSync(file, { readOnly: true });
  const folderAfter = peek
    .prepare('SELECT worktree_path FROM node WHERE id = ?')
    .get(madeAfter).worktree_path;
  peek.close();
  await bonsai.stop();

  await copyFile(backup, file);
  for (const extra of ['-wal', '-shm']) await rm(file + extra, { force: true });
  console.log('put the backup back');
  bonsai = await startBonsai(dataDir);

  for (const [name, id] of [
    ['untouched since the backup', untouched],
    ['ran again after the backup', ranAgain],
  ]) {
    const opened = await bonsai.api('GET', `/api/nodes/${id}`);
    console.log(`"${name}": open HTTP ${opened.status}, status ${opened.body?.node?.status}`);
    await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'next' });
    const after = (await bonsai.settle(id)).body;
    console.log(`  next run: ${after?.node?.status ?? short(after)} ${lastError(after)}`);
    if (after?.node?.status === 'interrupted') {
      const discard = await bonsai.api('POST', `/api/nodes/${id}/recover`, { action: 'discard' });
      console.log(
        `  Discard: HTTP ${discard.status} ${discard.status >= 400 ? short(discard.body) : ''}`,
      );
    }
  }
  const tree = (await bonsai.api('GET', `/api/projects/${project.projectId}/tree`)).body;
  console.log(
    `"made after the backup": on the map ${tree.nodes.some((n) => n.id === madeAfter)}, its folder still on disk ${existsSync(folderAfter)}`,
  );
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true });
}
