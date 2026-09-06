import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = '4';

/** Opens (creating if needed) the app database and applies the schema. */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'bonsai.db'));

  // schema.sql is copied next to the compiled output by the build.
  const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
  db.exec(schema);

  migrate(db);

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    SCHEMA_VERSION,
  );
  return db;
}

/**
 * Adds columns to databases created by an earlier version.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, so a table that already exists
 * is left exactly as it was -- new columns in the file would never appear in an
 * existing database, and every read of them would come back undefined. Bonsai
 * is a local app whose users have real trees in their database already, so the
 * fix is to add the column, not to ask them to delete it.
 */
function migrate(db: DatabaseSync): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );

  const projectColumns = columns('project');
  if (!projectColumns.has('default_effort')) {
    db.exec(`ALTER TABLE project ADD COLUMN default_effort TEXT`);
  }

  const runColumns = columns('run');
  const additions: Array<[string, string]> = [
    ['model', 'TEXT'],
    ['cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['cache_creation_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['api_key_source', 'TEXT'],
  ];
  for (const [name, type] of additions) {
    if (!runColumns.has(name)) db.exec(`ALTER TABLE run ADD COLUMN ${name} ${type}`);
  }
}

export function openInMemory(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}
