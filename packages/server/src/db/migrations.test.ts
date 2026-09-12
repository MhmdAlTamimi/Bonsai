import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from './open.js';
import {
  DatabaseTooNewError,
  LATEST_VERSION,
  currentVersion,
  runMigrations,
} from './migrations.js';

describe('schema migrations', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bonsai-mig-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a fresh database starts at the latest version without replaying migrations', () => {
    const db = openDatabase(dir);
    assert.equal(currentVersion(db), LATEST_VERSION);
    db.close();
  });

  test('an old database is migrated, and backed up first', () => {
    // A v1-era database: the run table without any of the later columns.
    const file = join(dir, 'bonsai.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
        repo_path TEXT NOT NULL, default_model TEXT, default_permission_mode TEXT NOT NULL
        DEFAULT 'acceptEdits', created_at TEXT NOT NULL);
      CREATE TABLE run (id TEXT PRIMARY KEY, node_id TEXT, status TEXT NOT NULL,
        started_at TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0);`);
    old.prepare(`INSERT INTO meta VALUES ('schema_version', '1')`).run();
    old
      .prepare(
        `INSERT INTO run (id,node_id,status,started_at,cost) VALUES ('r1','n1','done','t',0.5)`,
      )
      .run();
    old.close();

    const db = openDatabase(dir);
    assert.equal(currentVersion(db), LATEST_VERSION);

    const columns = (
      db.prepare(`PRAGMA table_info(run)`).all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    const nodeColumns = (
      db.prepare(`PRAGMA table_info(node)`).all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    for (const added of ['success_criteria', 'verification_hint']) {
      assert.ok(nodeColumns.includes(added), `missing node.${added}`);
    }

    for (const added of [
      'model',
      'cache_read_tokens',
      'api_key_source',
      'commit_sha',
      'tools_offered',
      'tool_calls',
      'duration_ms',
    ]) {
      assert.ok(columns.includes(added), `missing ${added}`);
    }

    // The row survived, and there is something to go back to.
    const row = db.prepare(`SELECT cost FROM run WHERE id = 'r1'`).get() as unknown as {
      cost: number;
    };
    assert.equal(row.cost, 0.5);
    assert.ok(existsSync(`${file}.v1.backup`), 'a backup must be written before migrating');
    db.close();
  });

  test('migrations are idempotent across repeated opens', () => {
    const first = openDatabase(dir);
    first.close();
    const second = openDatabase(dir);
    assert.equal(currentVersion(second), LATEST_VERSION);
    second.close();
  });

  test('a database from a NEWER Bonsai is refused, not silently used', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO meta VALUES ('schema_version', ?)`).run(String(LATEST_VERSION + 3));

    // Running an old build against a newer database looks fine right up until
    // it writes a row missing a column the newer build depends on.
    assert.throws(() => runMigrations(db), DatabaseTooNewError);
    db.close();
  });
});
