import type { DatabaseSync } from 'node:sqlite';

/**
 * Ordered schema migrations.
 *
 * Once anyone else has a tree, "delete your database" stops being an upgrade
 * path. Each entry runs exactly once, in order, and the version it leaves
 * behind is recorded — the previous code wrote a version into `meta` and never
 * read it back, so it was documentation rather than a mechanism.
 *
 * Adding one: append it. Never renumber, never edit a shipped migration — some
 * database out there has already run it, and changing it now means two machines
 * disagree about what version 4 means.
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).some(
    (c) => c.name === column,
  );

const addColumn = (db: DatabaseSync, table: string, column: string, type: string): void => {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline',
    // schema.sql creates everything a fresh database needs; this exists so a
    // database created before migrations were tracked lands on a known version.
    up: () => undefined,
  },
  {
    version: 2,
    name: 'run: model and cache token columns',
    up: (db) => {
      addColumn(db, 'run', 'model', 'TEXT');
      addColumn(db, 'run', 'cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run', 'cache_creation_tokens', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    version: 3,
    name: 'project: default effort',
    up: (db) => addColumn(db, 'project', 'default_effort', 'TEXT'),
  },
  {
    version: 4,
    name: 'run: credential source',
    up: (db) => addColumn(db, 'run', 'api_key_source', 'TEXT'),
  },
  {
    version: 5,
    name: 'run: commit produced',
    up: (db) => addColumn(db, 'run', 'commit_sha', 'TEXT'),
  },
  {
    version: 6,
    name: 'project: adopted directories',
    up: (db) => {
      addColumn(db, 'project', 'source_kind', "TEXT NOT NULL DEFAULT 'created'");
      addColumn(db, 'project', 'source_path', 'TEXT');
      addColumn(db, 'project', 'protected_branch', 'TEXT');
    },
  },
  {
    version: 7,
    name: 'run: what the agent was offered, and what it did',
    up: (db) => {
      addColumn(db, 'run', 'tools_offered', 'TEXT');
      addColumn(db, 'run', 'tool_calls', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run', 'duration_ms', 'INTEGER');
    },
  },
  {
    version: 8,
    name: 'node: what success looks like',
    up: (db) => {
      addColumn(db, 'node', 'success_criteria', 'TEXT');
      addColumn(db, 'node', 'verification_hint', 'TEXT');
    },
  },
  {
    version: 9,
    name: 'project: what a new node needs before the agent arrives',
    up: (db) => {
      addColumn(db, 'project', 'copy_files', 'TEXT');
      addColumn(db, 'project', 'setup_command', 'TEXT');
      addColumn(db, 'node', 'setup_ran_at', 'TEXT');
    },
  },
  {
    version: 10,
    name: 'run: how much the node has changed',
    up: (db) => {
      addColumn(db, 'run', 'stat_files', 'INTEGER');
      addColumn(db, 'run', 'stat_insertions', 'INTEGER');
      addColumn(db, 'run', 'stat_deletions', 'INTEGER');
    },
  },
  {
    version: 11,
    name: 'question: recorded action and input',
    up: (db) => {
      addColumn(db, 'question', 'request_json', 'TEXT');
    },
  },
  {
    version: 12,
    name: 'project: stable managed storage location',
    up: (db) => {
      addColumn(db, 'project', 'scratch_path', 'TEXT');
    },
  },
  {
    version: 13,
    name: 'project: the agent working directory inside the repository',
    up: (db) => {
      // '' means the repository root, which is what every existing project is:
      // adoption before D37 could only ever choose a repository root.
      addColumn(db, 'project', 'work_dir', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 14,
    name: 'run: why it ended, what it stopped, and what it alone changed',
    up: (db) => {
      addColumn(db, 'run', 'run_files', 'INTEGER');
      addColumn(db, 'run', 'run_added', 'INTEGER');
      addColumn(db, 'run', 'run_removed', 'INTEGER');
      addColumn(db, 'run', 'end_reason', 'TEXT');
      addColumn(db, 'run', 'stopped_background', 'INTEGER NOT NULL DEFAULT 0');
      // Older runs said why they ended only in prose, and only sometimes. The
      // app-exit wording is the one message that meant something different
      // from its status; every other ended run is read from its status alone.
      const appExit = hasColumn(db, 'run', 'error')
        ? `WHEN error = 'the app exited while this run was in flight' THEN 'app_closed'`
        : '';
      db.exec(
        `UPDATE run SET end_reason = CASE
           ${appExit}
           WHEN status = 'done' THEN 'finished'
           WHEN status = 'cancelled' THEN 'stopped'
           ELSE 'failed' END
         WHERE status != 'running' AND end_reason IS NULL`,
      );
    },
  },
  {
    version: 15,
    name: 'lazy checkouts and per-run resolved context',
    up: (db) => {
      addColumn(db, 'node', 'worktree_allocated', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'run', 'resolved_context', 'TEXT');
    },
  },
  {
    version: 16,
    name: 'node: where a copy of its conversation may be cut',
    up: (db) => addColumn(db, 'node', 'session_position', 'TEXT'),
  },
  {
    version: 17,
    name: 'references',
    // schema.sql creates the table and its index on every open (IF NOT EXISTS),
    // so an existing database already has them by now; this records the version.
    up: () => undefined,
  },
  {
    version: 18,
    name: 'comparisons, and references drawn from one',
    // The comparison tables come from schema.sql like references did; the
    // column on an existing references table has to be added. A database with
    // no references table yet gets it, column included, from schema.sql.
    up: (db) => {
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reference'`)
        .get();
      if (exists !== undefined) addColumn(db, 'reference', 'source_comparison_id', 'TEXT');
    },
  },
  {
    version: 19,
    name: 'comparison questions: the references each was asked with',
    up: (db) => {
      const exists = db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comparison_turn'`)
        .get();
      if (exists !== undefined) addColumn(db, 'comparison_turn', 'references_json', 'TEXT');
    },
  },
  {
    version: 20,
    name: 'node: archived folders',
    up: (db) => {
      addColumn(db, 'node', 'archived_at', 'TEXT');
      addColumn(db, 'node', 'restored_at', 'TEXT');
    },
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class DatabaseTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This database was written by a newer version of Bonsai (schema ${found}; this build ` +
        `understands ${supported}). Update Bonsai rather than running this build against it — ` +
        `an older build can silently drop data a newer one relies on.`,
    );
    this.name = 'DatabaseTooNewError';
  }
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as unknown as
    { value: string } | undefined;
  const parsed = Number(row?.value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Brings a database up to date, or refuses.
 *
 * Refusing matters as much as migrating: running an old build against a newer
 * database looks like it works right up until it writes a row missing a column
 * the newer build depends on.
 */
export function runMigrations(db: DatabaseSync): { from: number; to: number; applied: string[] } {
  const from = currentVersion(db);
  if (from > LATEST_VERSION) throw new DatabaseTooNewError(from, LATEST_VERSION);

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
        String(migration.version),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `migration ${migration.version} (${migration.name}) failed and was rolled back: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    applied.push(`${migration.version}: ${migration.name}`);
  }
  return { from, to: LATEST_VERSION, applied };
}
