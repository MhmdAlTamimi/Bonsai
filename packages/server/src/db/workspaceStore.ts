import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export interface WorkspaceRow {
  project_id: string;
  path: string;
  active_node_id: string | null;
  generation: number;
  held: number;
  switch_json: string | null;
  rebuild_paths: string;
}

/** Durable ownership; filesystem transitions are journaled by projectWorkspace.ts. */
export class WorkspaceStore {
  constructor(private readonly db: DatabaseSync) {}

  get(projectId: string): WorkspaceRow | undefined {
    return this.db.prepare('SELECT * FROM workspace WHERE project_id = ?').get(projectId) as
      WorkspaceRow | undefined;
  }

  create(projectId: string, path: string, activeNodeId: string | null = null): void {
    this.db
      .prepare('INSERT INTO workspace(project_id, path, active_node_id) VALUES (?, ?, ?)')
      .run(projectId, path, activeNodeId);
  }

  hold(projectId: string, held: boolean): void {
    this.db
      .prepare('UPDATE workspace SET held = ? WHERE project_id = ?')
      .run(Number(held), projectId);
  }

  configure(projectId: string, paths: readonly string[]): void {
    this.db
      .prepare('UPDATE workspace SET rebuild_paths = ? WHERE project_id = ?')
      .run(JSON.stringify(paths), projectId);
  }

  journal(projectId: string, value: unknown): void {
    this.db
      .prepare('UPDATE workspace SET switch_json = ? WHERE project_id = ?')
      .run(value === null ? null : JSON.stringify(value), projectId);
  }

  releaseOwnership(projectId: string): void {
    this.db
      .prepare(
        'UPDATE workspace SET active_node_id = NULL, generation = generation + 1, held = 0 WHERE project_id = ?',
      )
      .run(projectId);
  }

  /** Ownership and legacy compatibility columns change in one database transaction. */
  activate(projectId: string, nodeId: string | null, scratch: string): void {
    const workspace = this.get(projectId)!;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (workspace.active_node_id !== null) {
        this.db
          .prepare(
            `UPDATE node SET worktree_allocated = 0, worktree_path = ?,
          archived_at = COALESCE(archived_at, ?), setup_ran_at = NULL WHERE id = ?`,
          )
          .run(
            join(scratch, 'stored', workspace.active_node_id),
            new Date().toISOString(),
            workspace.active_node_id,
          );
      }
      if (nodeId !== null) {
        this.db
          .prepare(
            `UPDATE node SET worktree_allocated = 1, worktree_path = ?,
          branch_name = CASE WHEN head_commit IS NULL THEN NULL ELSE 'refs/bonsai/' || project_id || '/' || id END,
          archived_at = NULL, restored_at = ?, setup_ran_at = NULL WHERE id = ? AND project_id = ?`,
          )
          .run(workspace.path, new Date().toISOString(), nodeId, projectId);
      }
      this.db
        .prepare(
          `UPDATE workspace SET active_node_id = ?, generation = generation + 1,
        switch_json = NULL WHERE project_id = ?`,
        )
        .run(nodeId, projectId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
