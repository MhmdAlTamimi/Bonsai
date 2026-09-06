import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_VERSION = '1';

/** Opens (creating if needed) the app database and applies the schema. */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'bonsai.db'));

  // schema.sql is copied next to the compiled output by the build.
  const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
  db.exec(schema);

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    SCHEMA_VERSION,
  );
  return db;
}

export function openInMemory(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  return db;
}
