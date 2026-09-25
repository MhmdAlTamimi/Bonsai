import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ComparisonMessageView,
  ComparisonTurnView,
  ExperimentFacts,
  MessageView,
  RunStatus,
} from '@bonsai/shared';

import { now } from './rows.js';

export interface ComparisonRow {
  id: string;
  project_id: string;
  title: string;
  session_id: string | null;
  pending_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComparedExperimentRow {
  position: number;
  nodeId: string | null;
  name: string;
  folder: string;
  runs: number;
  facts: ExperimentFacts;
  snapshotAt: string;
}

/** A snapshot to record for one experiment of a comparison. */
export interface ComparedExperimentInput {
  nodeId: string;
  name: string;
  folder: string;
  runs: number;
  facts: ExperimentFacts;
}

/**
 * Comparisons: which experiments they read, and the conversation about them.
 * One concern-sized store behind the `Store` facade, owning the four
 * comparison tables and nothing else.
 */
export class ComparisonStore {
  constructor(private readonly db: DatabaseSync) {}

  list(projectId: string): ComparisonRow[] {
    return this.db
      .prepare(`SELECT * FROM comparison WHERE project_id = ? ORDER BY updated_at DESC`)
      .all(projectId) as unknown as ComparisonRow[];
  }

  get(id: string): ComparisonRow | undefined {
    return this.db.prepare(`SELECT * FROM comparison WHERE id = ?`).get(id) as unknown as
      ComparisonRow | undefined;
  }

  create(projectId: string, title: string, experiments: ComparedExperimentInput[]): ComparisonRow {
    const at = now();
    const row: ComparisonRow = {
      id: randomUUID(),
      project_id: projectId,
      title,
      session_id: null,
      pending_note: null,
      created_at: at,
      updated_at: at,
    };
    this.db
      .prepare(
        `INSERT INTO comparison (id, project_id, title, session_id, pending_note, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(row.id, row.project_id, row.title, at, at);
    experiments.forEach((experiment, position) =>
      this.insertExperiment(row.id, position, experiment),
    );
    return row;
  }

  experiments(comparisonId: string): ComparedExperimentRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM comparison_experiment WHERE comparison_id = ? ORDER BY position`)
      .all(comparisonId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      position: Number(r['position']),
      nodeId: (r['node_id'] as string | null) ?? null,
      name: r['name'] as string,
      folder: r['folder'] as string,
      runs: Number(r['runs']),
      facts: JSON.parse(r['facts_json'] as string) as ExperimentFacts,
      snapshotAt: r['snapshot_at'] as string,
    }));
  }

  /** A fresh snapshot of one experiment, replacing the old record at its position. */
  replaceExperiment(comparisonId: string, position: number, input: ComparedExperimentInput): void {
    this.db
      .prepare(`DELETE FROM comparison_experiment WHERE comparison_id = ? AND position = ?`)
      .run(comparisonId, position);
    this.insertExperiment(comparisonId, position, input);
  }

  rename(id: string, title: string): void {
    this.db
      .prepare(`UPDATE comparison SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, now(), id);
  }

  setSession(id: string, sessionId: string): void {
    this.db.prepare(`UPDATE comparison SET session_id = ? WHERE id = ?`).run(sessionId, id);
  }

  /** What to tell the agent with the next question; null once it has been told. */
  setPendingNote(id: string, note: string | null): void {
    this.db.prepare(`UPDATE comparison SET pending_note = ? WHERE id = ?`).run(note, id);
  }

  touch(id: string): void {
    this.db.prepare(`UPDATE comparison SET updated_at = ? WHERE id = ?`).run(now(), id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM comparison WHERE id = ?`).run(id);
  }

  // -- the conversation -----------------------------------------------------

  startTurn(comparisonId: string): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO comparison_turn (id, comparison_id, status, started_at) VALUES (?, ?, 'running', ?)`,
      )
      .run(id, comparisonId, now());
    this.touch(comparisonId);
    return id;
  }

  finishTurn(
    turnId: string,
    end: {
      status: Exclude<RunStatus, 'running'>;
      costUsd: number;
      model: string | null;
      error: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE comparison_turn SET status = ?, ended_at = ?, cost_usd = ?, model = ?, error = ? WHERE id = ?`,
      )
      .run(end.status, now(), end.costUsd, end.model, end.error, turnId);
  }

  turns(comparisonId: string): ComparisonTurnView[] {
    const rows = this.db
      .prepare(`SELECT * FROM comparison_turn WHERE comparison_id = ? ORDER BY started_at, rowid`)
      .all(comparisonId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      status: r['status'] as RunStatus,
      startedAt: r['started_at'] as string,
      endedAt: (r['ended_at'] as string | null) ?? null,
      costUsd: Number(r['cost_usd']),
      model: (r['model'] as string | null) ?? null,
      error: (r['error'] as string | null) ?? null,
    }));
  }

  /** Turns still marked running when the app starts belonged to a process that is gone. */
  markOrphanedTurnsFailed(): number {
    return Number(
      this.db
        .prepare(
          `UPDATE comparison_turn SET status = 'failed', ended_at = ?, error = 'Bonsai closed while this answer was being written.'
           WHERE status = 'running'`,
        )
        .run(now()).changes,
    );
  }

  appendMessage(input: {
    comparisonId: string;
    turnId: string | null;
    role: MessageView['role'];
    kind: MessageView['kind'];
    content: unknown;
  }): ComparisonMessageView {
    const next = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM comparison_message WHERE comparison_id = ?`,
      )
      .get(input.comparisonId) as unknown as { seq: number };
    const view: ComparisonMessageView = {
      id: randomUUID(),
      turnId: input.turnId,
      seq: Number(next.seq),
      role: input.role,
      kind: input.kind,
      content: input.content,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO comparison_message (id, comparison_id, turn_id, seq, role, kind, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        view.id,
        input.comparisonId,
        view.turnId,
        view.seq,
        view.role,
        view.kind,
        JSON.stringify(view.content),
        view.createdAt,
      );
    return view;
  }

  messages(comparisonId: string): ComparisonMessageView[] {
    const rows = this.db
      .prepare(`SELECT * FROM comparison_message WHERE comparison_id = ? ORDER BY seq`)
      .all(comparisonId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      turnId: (r['turn_id'] as string | null) ?? null,
      seq: Number(r['seq']),
      role: r['role'] as MessageView['role'],
      kind: r['kind'] as MessageView['kind'],
      content: JSON.parse(r['content_json'] as string) as unknown,
      createdAt: r['created_at'] as string,
    }));
  }

  private insertExperiment(
    comparisonId: string,
    position: number,
    input: ComparedExperimentInput,
  ): void {
    this.db
      .prepare(
        `INSERT INTO comparison_experiment
           (comparison_id, position, node_id, name, folder, runs, facts_json, snapshot_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comparisonId,
        position,
        input.nodeId,
        input.name,
        input.folder,
        input.runs,
        JSON.stringify(input.facts),
        now(),
      );
  }
}
