import type { DatabaseSync } from 'node:sqlite';
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

/** SDK-owned transcript entries, kept verbatim beside Bonsai's own durable state. */
export class SdkSessionStore implements SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO sdk_session (session_id, project_key, modified_at) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET project_key = excluded.project_key, modified_at = excluded.modified_at`,
        )
        .run(key.sessionId, key.projectKey, Date.now());
      // Importing a legacy/global transcript can recreate a missing mirror row.
      // Bind it to its known live owners in this same append transaction.
      if (
        !this.db
          .prepare('SELECT 1 FROM sdk_session_owner WHERE session_id = ? LIMIT 1')
          .get(key.sessionId)
      ) {
        this.db
          .prepare(
            'INSERT OR IGNORE INTO sdk_session_owner(session_id, node_id) SELECT ?, id FROM node WHERE session_id = ?',
          )
          .run(key.sessionId, key.sessionId);
        this.db
          .prepare(
            'INSERT OR IGNORE INTO sdk_session_owner(session_id, comparison_id) SELECT ?, id FROM comparison WHERE session_id = ?',
          )
          .run(key.sessionId, key.sessionId);
      }
      const append = this.db
        .prepare(`INSERT INTO sdk_session_entry (session_id, subpath, uuid, data_json)
        VALUES (?, ?, ?, ?) ON CONFLICT(session_id, subpath, uuid) WHERE uuid IS NOT NULL
        DO NOTHING`);
      for (const entry of entries)
        append.run(
          key.sessionId,
          key.subpath ?? '',
          typeof entry.uuid === 'string' && entry.uuid !== '' ? entry.uuid : null,
          JSON.stringify(entry),
        );
      this.db.exec('COMMIT');
      return Promise.resolve();
    } catch (error) {
      this.db.exec('ROLLBACK');
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return Promise.resolve(this.read(key));
  }
  private read(key: SessionKey, through?: number): SessionStoreEntry[] | null {
    // UUID identifies an owned session; cwd/projectKey changes when data is moved.
    const rows = this.db
      .prepare(
        `SELECT data_json FROM sdk_session_entry
      WHERE session_id = ? AND subpath = ? AND id <= ? ORDER BY id`,
      )
      .all(key.sessionId, key.subpath ?? '', through ?? Number.MAX_SAFE_INTEGER) as Array<{
      data_json: string;
    }>;
    return rows.length === 0
      ? null
      : rows.map((row) => JSON.parse(row.data_json) as SessionStoreEntry);
  }
  checkpoint(sessionId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(id) AS id FROM sdk_session_entry WHERE session_id = ?')
      .get(sessionId) as { id: number | null };
    return row.id;
  }
  /** Startup only, before jobs/HTTP: interrupted native forks have no owner. */
  removeUnowned(): void {
    this.db.exec(
      'DELETE FROM sdk_session WHERE NOT EXISTS (SELECT 1 FROM sdk_session_owner WHERE sdk_session_owner.session_id = sdk_session.session_id)',
    );
  }
  at(sessionId: string, through: number): SessionStore {
    return {
      append: (key, entries) => this.append(key, entries),
      load: (key) =>
        Promise.resolve(this.read(key, key.sessionId === sessionId ? through : undefined)),
      listSessions: (projectKey) => this.listSessions(projectKey),
      listSubkeys: (key) =>
        Promise.resolve(
          (
            this.db
              .prepare(
                `SELECT DISTINCT subpath FROM sdk_session_entry
        WHERE session_id = ? AND subpath <> '' AND id <= ? ORDER BY subpath`,
              )
              .all(
                key.sessionId,
                key.sessionId === sessionId ? through : Number.MAX_SAFE_INTEGER,
              ) as Array<{ subpath: string }>
          ).map((row) => row.subpath),
        ),
    };
  }

  listSessions(_projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    return Promise.resolve(
      this.db
        .prepare(
          `SELECT session_id AS sessionId, modified_at AS mtime FROM sdk_session
      WHERE session_id IN (SELECT session_id FROM sdk_session_entry WHERE subpath = '')`,
        )
        .all() as Array<{ sessionId: string; mtime: number }>,
    );
  }
  listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return Promise.resolve(
      (
        this.db
          .prepare(
            `SELECT DISTINCT subpath FROM sdk_session_entry
      WHERE session_id = ? AND subpath <> '' ORDER BY subpath`,
          )
          .all(key.sessionId) as Array<{ subpath: string }>
      ).map((row) => row.subpath),
    );
  }
}
