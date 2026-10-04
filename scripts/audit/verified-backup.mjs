/** Full-backup regression: idle guard, custom storage, independent Git and a new data location. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startBonsai, gitEnv } from './lib.mjs';

const run = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'bonsai-verified-backup-'));
const original = join(root, 'original');
const data = join(original, 'data');
let bonsai = await startBonsai(data, { BONSAI_FAKE_DELAY_MS: '150' });
try {
  assert.equal(
    (
      await bonsai.api('PATCH', '/api/settings', {
        reposRoot: join(original, 'custom-projects'),
      })
    ).status,
    200,
  );
  const created = (
    await bonsai.api('POST', '/api/projects', { name: 'verified backup', description: '' })
  ).body;
  const source = join(original, 'external-source');
  await mkdir(source);
  await run('git', ['init', '--initial-branch=main'], { cwd: source, env: gitEnv });
  await writeFile(join(source, 'app.txt'), 'independent source\n');
  await run('git', ['add', '-A'], { cwd: source, env: gitEnv });
  await run('git', ['commit', '-m', 'source'], { cwd: source, env: gitEnv });
  const adoptedResponse = await bonsai.api('POST', '/api/projects/adopt', {
    path: source,
    description: '',
  });
  assert.equal(adoptedResponse.status, 201, JSON.stringify(adoptedResponse.body));
  const adopted = adoptedResponse.body;
  const ids = [];
  for (const project of [created, adopted]) {
    for (let n = 0; n < 2; n++) {
      const child = await bonsai.api('POST', `/api/projects/${project.projectId}/nodes`, {
        parentId: project.masterNodeId,
        displayName: `continuation ${n}`,
        description: '',
      });
      assert.equal(child.status, 201);
      ids.push(child.body.node.id);
    }
  }
  for (const id of ids)
    assert.equal(
      (await bonsai.api('POST', `/api/nodes/${id}/runs`, { prompt: 'before backup' })).status,
      202,
    );
  assert.equal((await bonsai.api('POST', '/api/backup', {})).status, 409);
  await Promise.all(ids.map((id) => bonsai.settle(id)));
  const response = await bonsai.api('POST', '/api/backup', {});
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(
    JSON.parse(await readFile(join(response.body.path, 'backup.json'), 'utf8')).complete,
    true,
  );
  await bonsai.stop('SIGTERM');
  const restored = join(root, 'restored');
  await rename(response.body.path, restored);
  await rm(original, { recursive: true, force: true });
  bonsai = await startBonsai(restored);
  for (const id of ids) {
    assert.equal(
      (
        await bonsai.api('POST', `/api/nodes/${id}/runs`, {
          prompt: 'continue after losing original folders',
        })
      ).status,
      202,
    );
    const after = await bonsai.settle(id);
    assert.equal(after.body.node.status, 'ready', JSON.stringify(after.body.runs.at(-1)));
    assert.equal(after.body.runs.at(-1).status, 'done');
  }
  const db = new DatabaseSync(join(restored, 'bonsai.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    for (const project of db.prepare('SELECT repo_path FROM project').all())
      await run('git', ['fsck', '--full', '--no-dangling'], {
        cwd: project.repo_path,
        env: gitEnv,
      });
  } finally {
    db.close();
  }
  console.log(
    JSON.stringify({
      experiments: ids.length,
      completedAfterRestore: ids.length,
      originalFoldersRemoved: true,
      integrity: 'ok',
    }),
  );
} finally {
  await bonsai.stop();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
