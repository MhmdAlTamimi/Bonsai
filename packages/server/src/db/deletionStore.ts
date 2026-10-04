import type { DatabaseSync } from 'node:sqlite';
import type { NodeView } from '@bonsai/shared';
import type { NodeRow, ProjectRow } from './rows.js';

export interface DeletionIntent {
  id: string;
  kind: 'node' | 'project';
  project: ProjectRow;
  nodes: NodeRow[];
  rootNodeId: string | null;
  error: string | null;
}

/** A confirmed deletion remains retryable after any filesystem or database interruption. */
export class DeletionStore {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): DeletionIntent | undefined {
    return this.pending().find((intent) => intent.id === id);
  }
  pending(): DeletionIntent[] {
    return (
      this.db
        .prepare('SELECT payload_json, error FROM deletion_operation')
        .all() as unknown as Array<{ payload_json: string; error: string | null }>
    ).map((row) => ({ ...(JSON.parse(row.payload_json) as DeletionIntent), error: row.error }));
  }
  forNode(id: string): DeletionIntent | undefined {
    return this.pending().find((intent) => intent.nodes.some((node) => node.id === id));
  }
  views(projectId: string): Map<string, NonNullable<NodeView['deletion']>> {
    const views = new Map<string, NonNullable<NodeView['deletion']>>();
    for (const intent of this.pending()) {
      if (intent.project.id !== projectId) continue;
      for (const node of intent.nodes)
        views.set(node.id, {
          id: intent.id,
          kind: intent.kind,
          error: intent.error,
          rootNodeId: intent.rootNodeId,
        });
    }
    return views;
  }
  prepare(intent: Omit<DeletionIntent, 'error'>): void {
    this.db
      .prepare('INSERT INTO deletion_operation (id, payload_json) VALUES (?, ?)')
      .run(intent.id, JSON.stringify(intent));
  }
  blocked(id: string, error: string): void {
    this.db.prepare('UPDATE deletion_operation SET error = ? WHERE id = ?').run(error, id);
  }
  remove(id: string): void {
    this.db.prepare('DELETE FROM deletion_operation WHERE id = ?').run(id);
  }
}
