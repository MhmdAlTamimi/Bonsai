import type { DatabaseSync } from 'node:sqlite';
import type { ProjectUsageView, RunStatus } from '@bonsai/shared';
import type { RunEvent } from '../agent/AgentRunner.js';
import { now } from './rows.js';

type UsageRun = ProjectUsageView['experiments'][number]['runs'][number];
interface Row {
  id: string;
  kind: 'experiment' | 'comparison' | 'draft';
  owner_id: string;
  owner_name: string;
  status: RunStatus;
  started_at: string;
  metrics_json: string;
}

export class UsageStore {
  constructor(private readonly db: DatabaseSync) {}

  createDraft(id: string, projectId: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO usage_entry(id, project_id, kind, owner_id, owner_name, status, started_at, cost, metrics_json)
      VALUES(?, ?, 'draft', ?, ?, 'running', ?, NULL, ?)`,
      )
      .run(
        id,
        projectId,
        id,
        name,
        now(),
        JSON.stringify({ usageStatus: 'unknown', model: null, apiKeySource: null }),
      );
  }

  recordDraft(id: string, event: Extract<RunEvent, { type: 'done' | 'model' }>): void {
    const row = this.db.prepare('SELECT metrics_json FROM usage_entry WHERE id = ?').get(id) as
      { metrics_json: string } | undefined;
    if (!row) return;
    const metrics = JSON.parse(row.metrics_json) as Record<string, unknown>;
    if (event.type === 'model')
      Object.assign(metrics, { model: event.model, apiKeySource: event.apiKeySource ?? null });
    else
      Object.assign(metrics, event, {
        model: event.model ?? metrics['model'],
        usageStatus: event.usageStatus ?? 'recorded',
      });
    this.db
      .prepare('UPDATE usage_entry SET cost = ?, metrics_json = ? WHERE id = ?')
      .run(
        metrics['usageStatus'] === 'recorded' ? Number(metrics['costUsd']) : null,
        JSON.stringify(metrics),
        id,
      );
  }

  finishDraft(id: string, status: Exclude<RunStatus, 'running'>): void {
    this.db.prepare('UPDATE usage_entry SET status = ? WHERE id = ?').run(status, id);
  }

  markOrphanedDrafts(): void {
    this.db.exec(
      "UPDATE usage_entry SET status = 'failed' WHERE kind = 'draft' AND status = 'running'",
    );
  }

  projectCost(projectId: string): number {
    return Number(
      (
        this.db
          .prepare('SELECT COALESCE(SUM(cost), 0) AS total FROM usage_entry WHERE project_id = ?')
          .get(projectId) as { total: number }
      ).total,
    );
  }

  view(projectId: string): ProjectUsageView {
    const result: ProjectUsageView = { projectId, experiments: [], comparisons: [], drafts: [] };
    const nodes = this.db
      .prepare('SELECT id, display_name AS name FROM node WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as Array<{ id: string; name: string }>;
    const comparisons = this.db
      .prepare('SELECT id, title AS name FROM comparison WHERE project_id = ? ORDER BY created_at')
      .all(projectId) as Array<{ id: string; name: string }>;
    const groups = {
      experiment: new Map(
        nodes.map((node) => [node.id, { ...node, deleted: false, runs: [] as UsageRun[] }]),
      ),
      comparison: new Map(
        comparisons.map((row) => [row.id, { ...row, deleted: false, runs: [] as UsageRun[] }]),
      ),
    };
    const rows = this.db
      .prepare('SELECT * FROM usage_entry WHERE project_id = ? ORDER BY started_at, rowid')
      .all(projectId) as unknown as Row[];
    for (const row of rows) {
      const metrics = JSON.parse(row.metrics_json) as Partial<UsageRun>;
      const run: UsageRun = {
        id: row.id,
        status: row.status,
        startedAt: row.started_at,
        costUsd: metrics.costUsd ?? 0,
        inputTokens: metrics.inputTokens ?? 0,
        outputTokens: metrics.outputTokens ?? 0,
        cacheReadTokens: metrics.cacheReadTokens ?? 0,
        cacheCreationTokens: metrics.cacheCreationTokens ?? 0,
        model: metrics.model ?? null,
        apiKeySource: metrics.apiKeySource ?? null,
        usageStatus: metrics.usageStatus ?? 'unknown',
      };
      if (row.kind === 'draft') {
        result.drafts.push(run);
        continue;
      }
      let group = groups[row.kind].get(row.owner_id);
      if (!group) {
        group = { id: row.owner_id, name: row.owner_name, deleted: true, runs: [] };
        groups[row.kind].set(row.owner_id, group);
      }
      group.runs.push(run);
    }
    result.experiments = [...groups.experiment.values()];
    result.comparisons = [...groups.comparison.values()];
    return result;
  }
}

/** Install after column migrations so older run transforms cannot fire these early. */
export function installUsageTriggers(db: DatabaseSync): void {
  const run = `INSERT INTO usage_entry(id, project_id, kind, owner_id, owner_name, status, started_at, cost, metrics_json)
    SELECT NEW.id, n.project_id, 'experiment', n.id, n.display_name, NEW.status, NEW.started_at,
      CASE WHEN NEW.usage_status = 'recorded' THEN NEW.cost ELSE NULL END,
      json_object('costUsd', NEW.cost, 'inputTokens', NEW.input_tokens, 'outputTokens', NEW.output_tokens,
        'cacheReadTokens', NEW.cache_read_tokens, 'cacheCreationTokens', NEW.cache_creation_tokens,
        'model', NEW.model, 'apiKeySource', NEW.api_key_source, 'usageStatus', NEW.usage_status)
    FROM node n WHERE n.id = NEW.node_id
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, cost = excluded.cost, metrics_json = excluded.metrics_json;`;
  const comparison = `INSERT INTO usage_entry(id, project_id, kind, owner_id, owner_name, status, started_at, cost, metrics_json)
    SELECT NEW.id, c.project_id, 'comparison', c.id, c.title, NEW.status, NEW.started_at,
      CASE WHEN json_extract(NEW.usage_json, '$.usageStatus') = 'recorded' THEN NEW.cost_usd ELSE NULL END,
      json_patch(COALESCE(NEW.usage_json, '{"usageStatus":"unknown"}'), json_object('costUsd', NEW.cost_usd, 'model', NEW.model))
    FROM comparison c WHERE c.id = NEW.comparison_id
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, cost = excluded.cost, metrics_json = excluded.metrics_json;`;
  for (const [table, body] of [
    ['run', run],
    ['comparison_turn', comparison],
  ])
    for (const action of ['INSERT', 'UPDATE'])
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS ${table}_usage_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN ${body} END;`,
      );
}
