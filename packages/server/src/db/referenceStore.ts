import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

import { OperationConflict } from '../domain/errors.js';
import { now } from './rows.js';

export interface ReferenceRow {
  id: string;
  project_id: string;
  name: string;
  content: string;
  source_node_id: string | null;
  source_comparison_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Longest name, in characters. It is typed after `@` and shown on a chip. */
export const REFERENCE_NAME_MAX = 80;
/** Largest reference, in characters. Big enough for a real procedure or result. */
export const REFERENCE_CONTENT_MAX = 100_000;

/**
 * Identifies a version of a reference's content. Recorded with every run that
 * received it, so "edited since" is a comparison rather than a timestamp guess.
 */
export function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/**
 * References: text written on purpose that any experiment in a project can be
 * given. One concern-sized store behind the `Store` facade; it owns the
 * `reference` table and nothing else.
 */
export class ReferenceStore {
  constructor(private readonly db: DatabaseSync) {}

  list(projectId: string): ReferenceRow[] {
    return this.db
      .prepare(`SELECT * FROM reference WHERE project_id = ? ORDER BY name COLLATE NOCASE`)
      .all(projectId) as unknown as ReferenceRow[];
  }

  get(id: string): ReferenceRow | undefined {
    return this.db.prepare(`SELECT * FROM reference WHERE id = ?`).get(id) as unknown as
      ReferenceRow | undefined;
  }

  create(input: {
    projectId: string;
    name: string;
    content: string;
    sourceNodeId: string | null;
    sourceComparisonId?: string | null;
  }): ReferenceRow {
    const at = now();
    const row: ReferenceRow = {
      id: randomUUID(),
      project_id: input.projectId,
      name: input.name,
      content: input.content,
      source_node_id: input.sourceNodeId,
      source_comparison_id: input.sourceComparisonId ?? null,
      created_at: at,
      updated_at: at,
    };
    unique(input.name, () =>
      this.db
        .prepare(
          `INSERT INTO reference (id, project_id, name, content, source_node_id,
             source_comparison_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.project_id,
          row.name,
          row.content,
          row.source_node_id,
          row.source_comparison_id,
          row.created_at,
          row.updated_at,
        ),
    );
    return row;
  }

  /** `sourceNodeId` changes only when given: a fill from another experiment re-sources it. */
  update(
    id: string,
    patch: { name?: string; content?: string; sourceNodeId?: string | null },
  ): void {
    const current = this.get(id);
    if (current === undefined) return;
    const name = patch.name ?? current.name;
    const source = patch.sourceNodeId === undefined ? current.source_node_id : patch.sourceNodeId;
    unique(name, () =>
      this.db
        .prepare(
          `UPDATE reference SET name = ?, content = ?, source_node_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(name, patch.content ?? current.content, source, now(), id),
    );
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM reference WHERE id = ?`).run(id);
  }
}

/** Runs a write, turning the name index's refusal into something a person can act on. */
function unique(name: string, write: () => unknown): void {
  try {
    write();
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
      throw new OperationConflict(`A reference named "${name}" already exists in this project.`);
    }
    throw error;
  }
}
