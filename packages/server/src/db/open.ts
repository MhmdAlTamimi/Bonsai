import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LATEST_VERSION, currentVersion, runMigrations } from './migrations.js';
import { installUsageTriggers } from './usageStore.js';

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

  try {
    // Inspect and back up the original database before even adding current tables.
    const hasMeta = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get();
    const originalVersion = hasMeta ? currentVersion(db) : 0;
    if (originalVersion > LATEST_VERSION) {
      runMigrations(db); // Raises DatabaseTooNewError without writing anything.
    }
    if (existed && originalVersion > 0 && originalVersion < LATEST_VERSION) {
      const preferred = `${file}.v${originalVersion}.backup`;
      const backup = existsSync(preferred) ? `${preferred}.${randomUUID()}.backup` : preferred;
      const temporary = `${backup}.tmp`;
      try {
        db.prepare('VACUUM INTO ?').run(temporary);
        renameSync(temporary, backup);
        process.stdout.write(`[bonsai] backed up the database to ${backup}\n`);
      } catch (err) {
        throw new Error(
          `refusing to migrate without a backup: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        rmSync(temporary, { force: true });
      }
    }

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
      installUsageTriggers(db);
      return db;
    }

    const result = runMigrations(db);
    installUsageTriggers(db);
    for (const step of result.applied) process.stdout.write(`[bonsai] migrated — ${step}\n`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openInMemory(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(LATEST_VERSION),
  );
  installUsageTriggers(db);
  return db;
}
