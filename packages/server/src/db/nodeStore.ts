import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { NodeStatus, PermissionMode } from '@bonsai/shared';

import { resolveBaseCommit } from '../domain/lineage.js';
import { blankToNull, now, toLineage, type NodeRow } from './rows.js';

/**
 * Nodes: the tree's rows, and the writes D3 allows against them.
 *
 * Everything that reads a node to answer a question ABOUT the tree -- flags,
 * lineage, costs -- lives in `views.ts`. What is here is the row itself.
 */
export class NodeStore {
  constructor(
    private readonly db: DatabaseSync,
    /** Where this project's worktrees go. Owned by the project store. */
    private readonly scratchDir: (projectId: string) => string,
  ) {}

  /**
   * Inserts a node, pinning its git base via the lineage rule.
   *
   * `baseCommit`/`headCommit` are passed in rather than computed here for
   * master alone -- the root commit is written by the git layer before the
   * project's first node exists. Every other node's base comes from
   * resolveBaseCommit() and is never recomputed afterwards.
   */
  create(input: {
    projectId: string;
    parentId: string | null;
    displayName: string;
    description: string;
    model?: string | null;
    permissionMode?: PermissionMode | null;
    /** Master only. Every other node derives its base from its parent. */
    rootCommit?: string;
    rootBranchName?: string;
    /** Master of an adopted project: its worktree IS the user's directory. */
    worktreePath?: string;
    /** Optional, and nothing depends on them being set. See the schema. */
    successCriteria?: string | null;
    verificationHint?: string | null;
  }): NodeRow {
    const id = randomUUID();

    let baseCommit: string | null = null;
    let headCommit: string | null = null;
    let branchName: string | null = null;

    if (input.parentId === null) {
      // Master. The git layer has already written the root empty commit; the
      // termination invariant depends on head_commit being set here.
      baseCommit = null;
      headCommit = input.rootCommit ?? null;
      branchName = input.rootBranchName ?? (headCommit === null ? null : 'master');
    } else {
      const parent = this.get(input.parentId);
      if (parent === undefined) throw new Error(`unknown parent ${input.parentId}`);
      baseCommit = resolveBaseCommit(toLineage(parent));
      // Emergent model: no branch and no commit until a run changes files.
    }

    const row: NodeRow = {
      id,
      project_id: input.projectId,
      parent_id: input.parentId,
      display_name: input.displayName,
      description: input.description,
      session_id: null,
      forked_from_message_seq: null,
      session_position: null,
      branch_name: branchName,
      base_commit: baseCommit,
      head_commit: headCommit,
      worktree_path: input.worktreePath ?? join(this.scratchDir(input.projectId), 'worktrees', id),
      worktree_allocated: 1,
      status: 'new',
      model: input.model ?? null,
      permission_mode: input.permissionMode ?? null,
      success_criteria: blankToNull(input.successCriteria),
      verification_hint: blankToNull(input.verificationHint),
      setup_ran_at: null,
      archived_at: null,
      restored_at: null,
      position_x: null,
      position_y: null,
      created_at: now(),
    };

    this.db
      .prepare(
        `INSERT INTO node (id, project_id, parent_id, display_name, description,
                           session_id, forked_from_message_seq, branch_name,
                           base_commit, head_commit, worktree_path, status, model,
                           permission_mode, success_criteria, verification_hint,
                           position_x, position_y, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.project_id,
        row.parent_id,
        row.display_name,
        row.description,
        row.session_id,
        row.forked_from_message_seq,
        row.branch_name,
        row.base_commit,
        row.head_commit,
        row.worktree_path,
        row.status,
        row.model,
        row.permission_mode,
        row.success_criteria,
        row.verification_hint,
        row.position_x,
        row.position_y,
        row.created_at,
      );
    return row;
  }

  get(id: string): NodeRow | undefined {
    return this.db.prepare(`SELECT * FROM node WHERE id = ?`).get(id) as unknown as
      NodeRow | undefined;
  }

  list(projectId: string): NodeRow[] {
    return this.db
      .prepare(`SELECT * FROM node WHERE project_id = ? ORDER BY created_at ASC`)
      .all(projectId) as unknown as NodeRow[];
  }

  /**
   * Every node worktree Bonsai knows about, in one query.
   *
   * The folder picker asks "do you already own this path?" on every keystroke
   * that settles, and answering it by listing the nodes of each project in turn
   * was a query per project plus a full row read per node. This is the one
   * question that needs every project at once, so it is the one query that
   * crosses them.
   */
  allWorktrees(): Array<{ id: string; project_id: string; worktree_path: string }> {
    return this.db
      .prepare(`SELECT id, project_id, worktree_path FROM node`)
      .all() as unknown as Array<{ id: string; project_id: string; worktree_path: string }>;
  }

  /** D33: display name and position only. D3 forbids everything else. */
  update(
    id: string,
    patch: {
      displayName?: string;
      positionX?: number | null;
      positionY?: number | null;
      successCriteria?: string;
      verificationHint?: string;
    },
  ): void {
    if (patch.successCriteria !== undefined)
      this.db
        .prepare('UPDATE node SET success_criteria = ? WHERE id = ?')
        .run(blankToNull(patch.successCriteria), id);
    if (patch.verificationHint !== undefined)
      this.db
        .prepare('UPDATE node SET verification_hint = ? WHERE id = ?')
        .run(blankToNull(patch.verificationHint), id);
    if (patch.displayName !== undefined) {
      this.db.prepare(`UPDATE node SET display_name = ? WHERE id = ?`).run(patch.displayName, id);
    }
    if (patch.positionX !== undefined || patch.positionY !== undefined) {
      this.db
        .prepare(`UPDATE node SET position_x = ?, position_y = ? WHERE id = ?`)
        .run(patch.positionX ?? null, patch.positionY ?? null, id);
    }
  }

  setStatus(id: string, status: NodeStatus): void {
    this.db.prepare(`UPDATE node SET status = ? WHERE id = ?`).run(status, id);
  }

  /** D7: cascades to descendants via the foreign key. */
  delete(id: string): void {
    this.db.prepare(`DELETE FROM node WHERE id = ?`).run(id);
  }

  /** Every node in the subtree rooted at `id`, deepest first. */
  descendantsOf(id: string): NodeRow[] {
    const root = this.get(id);
    if (!root) return [];
    const all = this.list(root.project_id);
    const byId = new Map(all.map((row) => [row.id, row]));
    const childrenOf = new Map<string, string[]>();
    for (const row of all) {
      if (row.parent_id === null) continue;
      const children = childrenOf.get(row.parent_id) ?? [];
      children.push(row.id);
      childrenOf.set(row.parent_id, children);
    }
    const out: NodeRow[] = [];
    const visited = new Set<string>();
    const stack: Array<[string, boolean]> = [[id, false]];
    while (stack.length > 0) {
      const [nodeId, expanded] = stack.pop()!;
      const row = byId.get(nodeId);
      if (!row) continue;
      if (expanded) {
        out.push(row);
        continue;
      }
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      stack.push([nodeId, true]);
      for (const child of [...(childrenOf.get(nodeId) ?? [])].reverse()) stack.push([child, false]);
    }
    return out;
  }

  /** A3: where a child's fork was taken from its parent's conversation. */
  /** A session copied from the parent at creation, and how much of it there was. */
  adoptForkedSession(id: string, sessionId: string, parentMessageSeq: number): void {
    this.db
      .prepare(`UPDATE node SET session_id = ?, forked_from_message_seq = ? WHERE id = ?`)
      .run(sessionId, parentMessageSeq, id);
  }

  /** Where a later copy of this conversation should end: see `session_position`. */
  setSessionPosition(id: string, messageId: string | null): void {
    this.db.prepare(`UPDATE node SET session_position = ? WHERE id = ?`).run(messageId, id);
  }

  markAllocated(id: string, allocated: boolean): void {
    this.db
      .prepare('UPDATE node SET worktree_allocated = ? WHERE id = ?')
      .run(allocated ? 1 : 0, id);
  }

  /**
   * The folder is gone; everything else stays. Setup runs again when the
   * folder is created again, because what it installed went with it.
   */
  markArchived(id: string): void {
    this.db
      .prepare(
        `UPDATE node SET worktree_allocated = 0, archived_at = ?, setup_ran_at = NULL WHERE id = ?`,
      )
      .run(now(), id);
  }

  /** An archived folder created again, at the same path. */
  markRestored(id: string): void {
    this.db
      .prepare(
        `UPDATE node SET worktree_allocated = 1, archived_at = NULL, restored_at = ? WHERE id = ?`,
      )
      .run(now(), id);
  }

  /**
   * When each of a project's experiments was last used: its newest run, or
   * when its folder was created again, or when it was created. Idle time for
   * automatic archiving counts from here.
   */
  lastActive(projectId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT n.id AS id,
                MAX(n.created_at,
                    COALESCE(n.restored_at, ''),
                    COALESCE((SELECT MAX(COALESCE(r.ended_at, r.started_at)) FROM run r
                              WHERE r.node_id = n.id), '')) AS at
         FROM node n WHERE n.project_id = ?`,
      )
      .all(projectId) as unknown as Array<{ id: string; at: string }>;
    return new Map(rows.map((row) => [row.id, row.at]));
  }

  setSessionId(id: string, sessionId: string): void {
    this.db.prepare(`UPDATE node SET session_id = ? WHERE id = ?`).run(sessionId, id);
  }

  /** Records that the setup command has run here, so it runs exactly once. */
  markSetupRan(nodeId: string): void {
    this.db.prepare(`UPDATE node SET setup_ran_at = ? WHERE id = ?`).run(now(), nodeId);
  }

  /**
   * Records a node's commit, creating its branch reference in the row.
   *
   * base_commit is deliberately untouched: it is pinned at creation and
   * immutable. Only head_commit moves, and only forward (D29: never amend).
   */
  recordCommit(id: string, branchName: string, headCommit: string): void {
    this.db
      .prepare(`UPDATE node SET branch_name = ?, head_commit = ? WHERE id = ?`)
      .run(branchName, headCommit, id);
  }
}
