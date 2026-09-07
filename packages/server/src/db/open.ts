import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LATEST_VERSION, currentVersion, runMigrations } from './migrations.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Opens (creating if needed) the app database, migrating it if necessary.
 *
 * The database is backed up before any migration runs. Bonsai's database holds
 * the only record of what every node was asked and what it answered -- runs
 * cost money and are not reproducible (PRD §11) -- so a failed upgrade must
 * leave something to go back to.
 */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'bonsai.db');
  const existed = existsSync(file);

  const db = new DatabaseSync(file);

  // schema.sql is CREATE TABLE IF NOT EXISTS throughout, so it is safe on an
  // existing database and creates a complete one from nothing.
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));

  const from = currentVersion(db);

  if (!existed || from === 0) {
    // A database created from the current schema.sql already has every column,
    // so it starts at the latest version rather than replaying migrations.
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(LATEST_VERSION),
    );
    return db;
  }

  if (from < LATEST_VERSION) {
    const backup = `${file}.v${from}.backup`;
    try {
      copyFileSync(file, backup);
      process.stdout.write(`[bonsai] backed up the database to ${backup}\n`);
    } catch (err) {
      throw new Error(
        `refusing to migrate without a backup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const result = runMigrations(db);
  for (const step of result.applied) process.stdout.write(`[bonsai] migrated — ${step}\n`);
  return db;
}

export function openInMemory(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(LATEST_VERSION),
  );
  return db;
}
