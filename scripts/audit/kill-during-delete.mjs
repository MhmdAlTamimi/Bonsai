/**
 * Audit phase 5: kill Bonsai while it deletes an experiment with five
 * children, at a later moment each round, and count what a restart shows.
 *
 *   npm run build:server && node scripts/audit/kill-during-delete.mjs
 *
 * "half-deleted" means experiments still on the map whose folder is gone.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { delay, startBonsai } from './lib.mjs';

const root = await mkdtemp(join(tmpdir(), 'bonsai-killdelete-'));
const dataDir = join(root, 'data');
const env = { BONSAI_FAKE_DELAY_MS: '10' };
let bonsai = await startBonsai(dataDir, env);
const tally = { nothingDeleted: 0, allDeleted: 0, halfDeleted: 0 };

try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'kill', description: '' }))
    .body;
  for (let round = 0; round < 10; round++) {
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const id = (
        await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
          parentId: i === 0 ? project.masterNodeId : ids[0],
          displayName: `round ${round} #${i}`,
          description: '',
        })
      ).body.node.id;
      await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'make a folder' });
      await bonsai.settle(id);
      ids.push(id);
    }
    const before = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
    const folders = ids.map(
      (id) => before.prepare('SELECT worktree_path FROM node WHERE id = ?').get(id).worktree_path,
    );
    before.close();

    const killAt = 15 + round * 12;
    void bonsai.api('DELETE', `/api/nodes/${ids[0]}`).catch(() => undefined);
    await delay(killAt);
    await bonsai.stop();
    bonsai = await startBonsai(dataDir, env);

    const after = new DatabaseSync(join(dataDir, 'bonsai.db'), { readOnly: true });
    const rows = ids.map((id, i) => ({
      onTheMap: after.prepare('SELECT 1 FROM node WHERE id = ?').get(id) !== undefined,
      folder: existsSync(folders[i]),
    }));
    after.close();
    const broken = rows.filter((r) => r.onTheMap && !r.folder).length;
    if (rows.every((r) => !r.onTheMap)) tally.allDeleted += 1;
    else if (broken > 0) {
      tally.halfDeleted += 1;
      console.log(`killed at ${killAt} ms: ${broken} of 6 still on the map with no folder`);
    } else tally.nothingDeleted += 1;
    // Clean up for the next round: a second delete finishes the job.
    if (rows.some((r) => r.onTheMap)) await bonsai.api('DELETE', `/api/nodes/${ids[0]}`);
  }
  console.log(JSON.stringify(tally));
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
