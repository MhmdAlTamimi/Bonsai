import type { DatabaseSync } from 'node:sqlite';

/**
 * Checks: what the user said success looks like, and who recorded the evidence.
 *
 * A small concern, and deliberately its own one. "Did this work?" is the
 * question the whole product exists to answer, and the two halves of the answer
 * -- the criteria the user wrote at creation, and the testing notes an agent
 * wrote during a run -- were previously scattered between a node column read
 * inline by the router and a join buried among the run queries.
 *
 * The notes themselves are NOT here. They live in the node's CONTEXT.md, which
 * is the agent's own record on disk (D22); this resolves which node and run a
 * given commit's notes belong to, so the panel can attribute them.
 */
export interface TestingSource {
  nodeId: string;
  nodeName: string;
  runId: string;
  recordedAt: string;
}

export interface NodeChecks {
  successCriteria: string | null;
  verificationHint: string | null;
}

export class CheckStore {
  constructor(private readonly db: DatabaseSync) {}

  /** What the user said success looks like for this node, as they wrote it. */
  of(nodeId: string): NodeChecks {
    const row = this.db
      .prepare(`SELECT success_criteria, verification_hint FROM node WHERE id = ?`)
      .get(nodeId) as unknown as
      { success_criteria: string | null; verification_hint: string | null } | undefined;
    return {
      successCriteria: row?.success_criteria ?? null,
      verificationHint: row?.verification_hint ?? null,
    };
  }

  /**
   * The run that produced a commit, so testing notes can name their source.
   *
   * Inherited notes are the case this exists for: a child branches from an
   * ancestor's commit and its CONTEXT.md still carries that ancestor's `##
   * Testing` section, which must not read as evidence about the child.
   */
  sourceOf(commit: string): TestingSource | null {
    return (
      (this.db
        .prepare(
          `SELECT n.id AS nodeId, n.display_name AS nodeName,
      r.id AS runId, r.ended_at AS recordedAt FROM run r JOIN node n ON n.id = r.node_id
      WHERE r.commit_sha = ? LIMIT 1`,
        )
        .get(commit) as TestingSource | undefined) ?? null
    );
  }
}
