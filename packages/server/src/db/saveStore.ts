import type { DatabaseSync } from 'node:sqlite';
import type { NodeStatus } from '@bonsai/shared';
import type { GitState } from '../git/ownership.js';
import type { RunTotals } from './rows.js';

/** Exact commit identity and database consequences; never inferred from commit prose. */
export interface RunSave {
  runId: string;
  nodeId: string;
  projectId: string;
  repoPath: string;
  worktreePath: string;
  workspaceGeneration?: number;
  before: GitState;
  after: string;
  totals: RunTotals;
  node: {
    status: NodeStatus;
    commit: { branch: string; head: string };
    sessionPosition?: string | null;
  };
}

export class SaveStore {
  constructor(private readonly db: DatabaseSync) {}
  prepare(save: RunSave): void {
    this.db
      .prepare('INSERT INTO run_save (run_id, payload_json) VALUES (?, ?)')
      .run(save.runId, JSON.stringify(save));
  }
  pending(): RunSave[] {
    return (
      this.db.prepare('SELECT payload_json FROM run_save').all() as unknown as Array<{
        payload_json: string;
      }>
    ).map((row) => JSON.parse(row.payload_json) as RunSave);
  }
  remove(runId: string): void {
    this.db.prepare('DELETE FROM run_save WHERE run_id = ?').run(runId);
  }
}
