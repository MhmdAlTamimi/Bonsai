/**
 * Audit D1: the pre-upgrade backup after a session that did not close cleanly.
 *
 *   npm run build:server && node scripts/audit/backup-after-crash.mjs
 *
 * Session 1 (a child process) opens a database, marks it one schema version
 * old, records a project with 50 experiments and exits without closing it, as
 * a crash, a kill or a closed terminal does. Session 2 opens it with the
 * current code, which backs it up and migrates. Then both are counted.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OPEN = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '../../packages/server/dist/db/open.js'),
).href;
const dir = mkdtempSync(join(tmpdir(), 'bonsai-backup-'));

const session1 = `
  import { openDatabase } from ${JSON.stringify(OPEN)};
  import { LATEST_VERSION } from ${JSON.stringify(OPEN.replace('open.js', 'migrations.js'))};
  import { randomUUID } from 'node:crypto';
  const db = openDatabase(${JSON.stringify(dir)});
  db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(LATEST_VERSION - 1));
  const now = new Date().toISOString();
  const project = randomUUID();
  db.prepare("INSERT INTO project (id, name, repo_path, created_at) VALUES (?, 'important', '/x', ?)").run(project, now);
  for (let i = 0; i < 50; i++)
    db.prepare("INSERT INTO node (id, project_id, display_name, worktree_path, status, created_at) VALUES (?, ?, 'n', '/x', 'ready', ?)").run(randomUUID(), project, now);
  process.exit(0);
`;

try {
  spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', session1], {
    stdio: 'inherit',
  });
  console.log('after session 1, the data folder holds:', readdirSync(dir).join(', '));

  const { openDatabase } = await import(OPEN);
  const db = openDatabase(dir);
  const live = db.prepare('SELECT count(*) AS n FROM node').get().n;
  db.close();

  const file = readdirSync(dir).find((name) => name.endsWith('.backup'));
  const backup = new DatabaseSync(join(dir, file), { readOnly: true });
  const tables = backup
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
    .get().n;
  const inBackup = tables === 0 ? 0 : backup.prepare('SELECT count(*) AS n FROM node').get().n;
  backup.close();
  console.log(`live database: ${live} experiments`);
  console.log(`${file}: ${tables} tables, ${inBackup} experiments`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
