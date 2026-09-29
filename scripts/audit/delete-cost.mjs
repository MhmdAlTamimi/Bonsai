/**
 * Audit D2: what deleting costs, with and without an index on message(run_id).
 *
 *   npm run build:server && node scripts/audit/delete-cost.mjs
 *
 * Builds a database the size of a heavy user's — 60 experiments × 20 runs ×
 * 150 messages — then times deleting one experiment and the whole project.
 * Every query runs on the server's only thread, so this is also how long the
 * app is frozen.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { openDatabase } = await import(
  pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), '../../packages/server/dist/db/open.js'),
  ).href
);

function build(withIndex) {
  const dir = mkdtempSync(join(tmpdir(), 'bonsai-delete-'));
  const db = openDatabase(dir);
  if (withIndex) db.exec('CREATE INDEX IF NOT EXISTS message_run_idx ON message(run_id)');
  const now = new Date().toISOString();
  const project = randomUUID();
  const root = randomUUID();
  db.prepare(`INSERT INTO project (id, name, repo_path, created_at) VALUES (?, 'p', '/x', ?)`).run(
    project,
    now,
  );
  db.prepare(
    `INSERT INTO node (id, project_id, display_name, worktree_path, status, created_at) VALUES (?, ?, 'm', '/x', 'ready', ?)`,
  ).run(root, project, now);
  const node = db.prepare(
    `INSERT INTO node (id, project_id, parent_id, display_name, base_commit, worktree_path, status, created_at) VALUES (?, ?, ?, 'e', 'abc', '/x', 'ready', ?)`,
  );
  const run = db.prepare(
    `INSERT INTO run (id, node_id, status, started_at) VALUES (?, ?, 'done', ?)`,
  );
  const message = db.prepare(
    `INSERT INTO message (id, node_id, run_id, seq, role, kind, content_json, created_at) VALUES (?, ?, ?, ?, 'assistant', 'text', '{"text":"x"}', ?)`,
  );
  const experiments = [];
  db.exec('BEGIN');
  for (let n = 0; n < 60; n++) {
    const id = randomUUID();
    experiments.push(id);
    node.run(id, project, root, now);
    let seq = 0;
    for (let r = 0; r < 20; r++) {
      const runId = randomUUID();
      run.run(runId, id, now);
      for (let m = 0; m < 150; m++) message.run(randomUUID(), id, runId, ++seq, now);
    }
  }
  db.exec('COMMIT');
  return { db, dir, experiments, project };
}

for (const withIndex of [false, true]) {
  const { db, dir, experiments, project } = build(withIndex);
  let start = performance.now();
  db.prepare('DELETE FROM node WHERE id = ?').run(experiments[0]);
  const one = performance.now() - start;
  start = performance.now();
  db.prepare('DELETE FROM project WHERE id = ?').run(project);
  const all = performance.now() - start;
  console.log(
    `${withIndex ? 'with   ' : 'without'} the index: one experiment (20 runs) ${Math.round(one)} ms, ` +
      `the project (1,200 runs, 180,000 messages) ${Math.round(all)} ms`,
  );
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
