import type { DatabaseSync } from 'node:sqlite';
import type { RunView } from '@bonsai/shared';

import { now, parseStringArray, type RunEnd, type RunTotals } from './rows.js';

/**
 * Runs: one agent request, from start to whatever ended it.
 *
 * Cost lives here too, because every figure the app quotes is a sum over runs.
 * The aggregate queries are grouped rather than per-node on purpose: the tree
 * view is rebuilt on every refetch, and a per-node query in that loop meant a
 * hundred-node project issued a hundred and one queries several times a second.
 */
export class RunStore {
  constructor(private readonly db: DatabaseSync) {}

  create(runId: string, nodeId: string): void {
    this.db
      .prepare(`INSERT INTO run (id, node_id, status, started_at) VALUES (?, ?, 'running', ?)`)
      .run(runId, nodeId, now());
  }

  finish(runId: string, end: RunEnd, totals: RunTotals): void {
    this.db
      .prepare(
        `UPDATE run SET status = ?, end_reason = ?, ended_at = ?, error = ?, cost = ?,
                        input_tokens = ?, output_tokens = ?,
                        cache_read_tokens = ?, cache_creation_tokens = ?, model = ?,
                        api_key_source = ?, commit_sha = ?, tools_offered = ?,
                        tool_calls = ?, duration_ms = ?, stat_files = ?,
                        stat_insertions = ?, stat_deletions = ?,
                        run_files = ?, run_added = ?, run_removed = ?,
                        stopped_background = ?
         WHERE id = ?`,
      )
      .run(
        end.status,
        end.reason,
        now(),
        end.error,
        totals.cost,
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheReadTokens ?? 0,
        totals.cacheCreationTokens ?? 0,
        totals.model ?? null,
        totals.apiKeySource ?? null,
        totals.commitSha ?? null,
        // JSON rather than a join table: it is written once, read whole, and
        // never queried by element.
        totals.toolsOffered == null ? null : JSON.stringify(totals.toolsOffered),
        totals.toolCalls ?? 0,
        totals.durationMs ?? null,
        totals.stat?.files ?? null,
        totals.stat?.insertions ?? null,
        totals.stat?.deletions ?? null,
        totals.change?.files ?? null,
        totals.change?.insertions ?? null,
        totals.change?.deletions ?? null,
        totals.stoppedBackground ?? 0,
        runId,
      );
  }

  get(
    runId: string,
  ): { id: string; node_id: string; status: string; commit_sha: string | null } | undefined {
    return this.db
      .prepare(`SELECT id, node_id, status, commit_sha FROM run WHERE id = ?`)
      .get(runId) as unknown as
      { id: string; node_id: string; status: string; commit_sha: string | null } | undefined;
  }

  list(nodeId: string): RunView[] {
    const rows = this.db
      .prepare(`SELECT * FROM run WHERE node_id = ? ORDER BY started_at ASC, rowid ASC`)
      .all(nodeId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      nodeId: r['node_id'] as string,
      status: r['status'] as RunView['status'],
      endReason: (r['end_reason'] as RunView['endReason']) ?? null,
      stoppedBackground: Number(r['stopped_background'] ?? 0),
      change:
        r['run_files'] == null
          ? null
          : {
              files: Number(r['run_files']),
              added: Number(r['run_added'] ?? 0),
              removed: Number(r['run_removed'] ?? 0),
            },
      startedAt: r['started_at'] as string,
      endedAt: (r['ended_at'] as string | null) ?? null,
      inputTokens: Number(r['input_tokens'] ?? 0),
      outputTokens: Number(r['output_tokens'] ?? 0),
      costUsd: Number(r['cost'] ?? 0),
      cacheReadTokens: Number(r['cache_read_tokens'] ?? 0),
      cacheCreationTokens: Number(r['cache_creation_tokens'] ?? 0),
      model: (r['model'] as string | null) ?? null,
      apiKeySource: (r['api_key_source'] as string | null) ?? null,
      commitSha: (r['commit_sha'] as string | null) ?? null,
      toolsOffered: parseStringArray(r['tools_offered']),
      toolCalls: Number(r['tool_calls'] ?? 0),
      durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
      error: (r['error'] as string | null) ?? null,
    }));
  }

  /** The commits one node produced, newest last. Cheaper than listing whole runs. */
  commitsOf(nodeId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT commit_sha FROM run
          WHERE node_id = ? AND commit_sha IS NOT NULL
          ORDER BY started_at ASC, rowid ASC`,
      )
      .all(nodeId) as unknown as Array<{ commit_sha: string }>;
    return rows.map((r) => r.commit_sha);
  }

  /**
   * One node's cost. Used by the panel, where there is exactly one node.
   *
   * NOT used when building a tree: see costsByNode below.
   */
  costOf(nodeId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS total FROM run WHERE node_id = ?`)
      .get(nodeId) as unknown as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /**
   * The total cost of a set of nodes, in one query.
   *
   * Deletion impact asks this about a whole subtree, and asking per node meant
   * a query per descendant every time a confirmation dialog opened.
   */
  costOfMany(nodeIds: readonly string[]): number {
    if (nodeIds.length === 0) return 0;
    const placeholders = nodeIds.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS total FROM run WHERE node_id IN (${placeholders})`)
      .get(...nodeIds) as unknown as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /** Every node's cost in a project, in one grouped query. */
  costsByNode(projectId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT r.node_id, SUM(r.cost) AS total
           FROM run r JOIN node n ON n.id = r.node_id
          WHERE n.project_id = ?
          GROUP BY r.node_id`,
      )
      .all(projectId) as unknown as Array<{ node_id: string; total: number }>;
    return new Map(rows.map((r) => [r.node_id, Number(r.total)]));
  }

  /** Every run in the project, so the cost of the whole tree is visible. */
  projectCost(projectId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(r.cost), 0) AS total FROM run r
         JOIN node n ON n.id = r.node_id WHERE n.project_id = ?`,
      )
      .get(projectId) as unknown as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /**
   * The newest committed run's stat, per node, in one query.
   *
   * One query for the whole project rather than one per node: the tree view is
   * rebuilt on every refetch, and every finished run triggers one.
   */
  statsByNode(projectId: string): Map<string, { files: number; added: number; removed: number }> {
    const rows = this.db
      .prepare(
        `SELECT r.node_id, r.stat_files, r.stat_insertions, r.stat_deletions
           FROM run r
           JOIN node n ON n.id = r.node_id
          WHERE n.project_id = ? AND r.stat_files IS NOT NULL
          ORDER BY r.started_at ASC`,
      )
      .all(projectId) as unknown as Array<{
      node_id: string;
      stat_files: number;
      stat_insertions: number;
      stat_deletions: number;
    }>;

    // Ascending, so the last write per node wins: the stat is cumulative
    // against the node's base, so the newest one is the whole story.
    const out = new Map<string, { files: number; added: number; removed: number }>();
    for (const r of rows) {
      out.set(r.node_id, {
        files: Number(r.stat_files),
        added: Number(r.stat_insertions),
        removed: Number(r.stat_deletions),
      });
    }
    return out;
  }

  /** The newest run's status per node, for the whole project, in one query. */
  latestStatusByNode(projectId: string): Map<string, RunView['status'] | null> {
    const rows = this.db
      .prepare(
        `SELECT n.id, (SELECT r.status FROM run r WHERE r.node_id = n.id
      ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1) AS status FROM node n WHERE n.project_id = ?`,
      )
      .all(projectId) as unknown as Array<{ id: string; status: RunView['status'] | null }>;
    return new Map(rows.map((r) => [r.id, r.status]));
  }

  /** Row counts, for the diagnostics report. One query each, not three lists. */
  counts(): { projects: number; nodes: number; runs: number; running: number } {
    const one = (sql: string): number => {
      const row = this.db.prepare(sql).get() as unknown as { n: number } | undefined;
      return Number(row?.n ?? 0);
    };
    return {
      projects: one(`SELECT COUNT(*) AS n FROM project`),
      nodes: one(`SELECT COUNT(*) AS n FROM node`),
      runs: one(`SELECT COUNT(*) AS n FROM run`),
      running: one(`SELECT COUNT(*) AS n FROM run WHERE status = 'running'`),
    };
  }

  /**
   * D31: any run still marked running at startup died with the process.
   *
   * Its end reason says so (D45) rather than an error message: the run did
   * not fail, Bonsai stopped existing underneath it.
   */
  markOrphanedInterrupted(): number {
    const runs = this.db
      .prepare(`SELECT id, node_id FROM run WHERE status = 'running'`)
      .all() as unknown as Array<{ id: string; node_id: string }>;
    for (const run of runs) {
      this.db
        .prepare(
          `UPDATE run SET status = 'failed', end_reason = 'app_closed', ended_at = ?, error = NULL
           WHERE id = ?`,
        )
        .run(now(), run.id);
      this.db.prepare(`UPDATE node SET status = 'interrupted' WHERE id = ?`).run(run.node_id);
    }
    return runs.length;
  }
}
