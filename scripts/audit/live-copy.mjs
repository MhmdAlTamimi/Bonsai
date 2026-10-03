/**
 * Audit phase 6: back up Bonsai's data folder by copying it while Bonsai is
 * running — what Time Machine, File History, a sync tool or `cp -r` does —
 * then restore each copy and see what it gives back.
 *
 *   npm run build:server && node scripts/audit/live-copy.mjs [copies]
 *
 * Four experiments keep running while the folder is copied. Each copy is
 * checked as files (SQLite's integrity check; whether every experiment's
 * hidden ref matches what the copied database says), then put back at the
 * original location — the paths inside are absolute — and every experiment
 * in it is run once more.
 */
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { delay, startBonsai } from './lib.mjs';

const copies = Number(process.argv[2] ?? 8);
const root = await mkdtemp(join(tmpdir(), 'bonsai-livecopy-'));
const dataDir = join(root, 'data');
const env = { BONSAI_FAKE_DELAY_MS: '30' };

function inspect(dir, projectId) {
  const db = new DatabaseSync(join(dir, 'bonsai.db'), { readOnly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const repo = db.prepare('SELECT repo_path FROM project WHERE id = ?').get(projectId).repo_path;
  const nodes = db
    .prepare(
      'SELECT id, head_commit, base_commit FROM node WHERE project_id = ? AND parent_id IS NOT NULL',
    )
    .all(projectId);
  db.close();
  return { integrity, repo, nodes };
}

let bonsai = await startBonsai(dataDir, env);
const ids = [];
let projectId;
try {
  const project = (await bonsai.api('POST', '/api/projects', { name: 'copy', description: '' }))
    .body;
  projectId = project.projectId;
  for (let i = 0; i < 4; i++)
    ids.push(
      (
        await bonsai.api('POST', `/api/projects/${projectId}/nodes`, {
          parentId: project.masterNodeId,
          displayName: `busy ${i}`,
          description: '',
        })
      ).body.node.id,
    );

  // Keep every experiment busy until the copies are taken.
  let busy = true;
  const workers = ids.map(async (id, i) => {
    for (let n = 0; busy; n++) {
      await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: `busy ${i} #${n}` });
      await bonsai.settle(id);
    }
  });
  await delay(1500);
  // A file can vanish between being listed and being copied (git's lock
  // files do, all the time). Some backup tools skip it, some give up; here a
  // copy that gives up is counted and taken again.
  let copyErrors = 0;
  for (let c = 0; c < copies;) {
    const dir = join(root, `copy-${c}`);
    try {
      await cp(dataDir, dir, { recursive: true });
      c++;
    } catch {
      copyErrors += 1;
      await rm(dir, { recursive: true, force: true });
    }
    await delay(300 + Math.floor(Math.random() * 400));
  }
  console.log(`copies that failed because a file vanished while copying: ${copyErrors}`);
  busy = false;
  await Promise.all(workers);
  await bonsai.stop();
  await rename(dataDir, join(root, 'original'));

  const tally = {
    integrityFailed: 0,
    refAheadOfDatabase: 0,
    databaseAheadOfRef: 0,
    stuckAfterRestore: 0,
    experiments: 0,
  };
  for (let c = 0; c < copies; c++) {
    const dir = join(root, `copy-${c}`);
    await rename(dir, dataDir);
    const { integrity, repo, nodes } = inspect(dataDir, projectId);
    if (integrity !== 'ok') tally.integrityFailed += 1;
    for (const node of nodes) {
      const tip = node.head_commit ?? node.base_commit;
      let ref = null;
      try {
        ref = execFileSync(
          'git',
          ['rev-parse', '--verify', '-q', `refs/bonsai/${projectId}/${node.id}`],
          {
            cwd: repo,
            stdio: ['ignore', 'pipe', 'ignore'],
          },
        )
          .toString()
          .trim();
      } catch {
        // No ref.
      }
      if (ref !== tip) {
        let refIsNewer = false;
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', tip, ref], {
            cwd: repo,
            stdio: 'ignore',
          });
          refIsNewer = true;
        } catch {
          // Not an ancestor, or the commit is missing.
        }
        if (refIsNewer) tally.refAheadOfDatabase += 1;
        else tally.databaseAheadOfRef += 1;
      }
    }
    bonsai = await startBonsai(dataDir, env);
    for (const id of ids) {
      tally.experiments += 1;
      await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'after the restore' });
      const after = await bonsai.settle(id);
      if (after.status !== 200 || after.body.node.status !== 'ready') {
        tally.stuckAfterRestore += 1;
        const reason =
          after.status !== 200
            ? JSON.stringify(after.body)
            : (after.body.runs?.at(-1)?.error ?? after.body.node.status);
        console.log(`copy ${c}: ${String(reason).split('\n')[0].slice(0, 150)}`);
      }
    }
    await bonsai.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
  console.log(`${copies} copies taken while 4 experiments ran:`);
  console.log(JSON.stringify(tally));
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
