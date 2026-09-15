import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { NodeLineageView, NodeView, ProjectView } from '@bonsai/shared';

import { deriveFlags } from '../domain/flags.js';
import { divergesFromLiveWalk, lookupFrom } from '../domain/lineage.js';
import type { MessageStore } from './messageStore.js';
import type { NodeStore } from './nodeStore.js';
import type { ProjectStore } from './projectStore.js';
import type { RunStore } from './runStore.js';
import {
  isInside,
  isUsersOwnCheckout,
  parseStringArray,
  toLineage,
  type NodeRow,
  type ProjectRow,
} from './rows.js';

/**
 * The read models: everything the interface is actually sent.
 *
 * This is the one place the concern-sized stores are allowed to meet, and it
 * only reads them. A view is assembled from rows plus the derivation rules in
 * `domain/` -- never from a stored copy of a derived fact, which is why
 * `createsBranch` and `writable` are not columns.
 */
export class Views {
  constructor(
    private readonly projects: ProjectStore,
    private readonly nodes: NodeStore,
    private readonly runs: RunStore,
    private readonly messages: MessageStore,
  ) {}

  /**
   * Building a tree issues a constant number of queries, whatever its size.
   *
   * Five: the project, the nodes, the costs, the diff stats, and the latest run
   * status. It used to be that plus one per node for cost alone.
   */
  tree(projectId: string): NodeView[] {
    const project = this.projects.get(projectId);
    const stats = this.runs.statsByNode(projectId);
    const costs = this.runs.costsByNode(projectId);
    const rows = this.nodes.list(projectId);
    const lastRuns = this.runs.latestStatusByNode(projectId);
    const childrenOf = new Map<string, NodeRow[]>();
    for (const row of rows) {
      if (row.parent_id === null) continue;
      const bucket = childrenOf.get(row.parent_id);
      if (bucket === undefined) childrenOf.set(row.parent_id, [row]);
      else bucket.push(row);
    }

    return rows.map((row) => {
      const children = childrenOf.get(row.id) ?? [];
      const flags = deriveFlags(
        { headCommit: row.head_commit },
        children.map((c) => ({ headCommit: c.head_commit })),
      );
      const question = row.status === 'needs_you' ? this.messages.pendingQuestion(row.id) : null;
      return {
        id: row.id,
        projectId: row.project_id,
        parentId: row.parent_id,
        displayName: row.display_name,
        // §7: for needs_you the card shows the agent's question instead, which
        // is what makes the canvas triageable at a glance.
        summaryLine: question?.text ?? row.description,
        status: row.status,
        lastRunStatus: lastRuns.get(row.id) ?? null,
        ...flags,
        // An adopted project's master worktree IS the user's own folder, on
        // their own branch. Nothing Bonsai does may write there, so master is
        // read-only from the moment the project exists rather than from its
        // first child. Expressed as the `writable` flag rather than a separate
        // rule so every renderer and the run gate agree without being told.
        writable: flags.writable && !isUsersOwnCheckout(project, row),
        frozenReason: isUsersOwnCheckout(project, row)
          ? 'your_folder'
          : flags.writable
            ? null
            : 'child_committed',
        pendingQuestion: question,
        positionX: row.position_x,
        positionY: row.position_y,
        diffStat: stats.get(row.id) ?? null,
        costUsd: costs.get(row.id) ?? 0,
        // Filled in by the router from the jobs runner. The store knows about
        // the tree, not about what this process happens to be doing with it.
        queuePosition: null,
        createdAt: row.created_at,
      } satisfies NodeView;
    });
  }

  project(row: ProjectRow): ProjectView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      defaultModel: row.default_model,
      defaultPermissionMode: row.default_permission_mode,
      defaultEffort: row.default_effort,
      sourceKind: row.source_kind,
      sourcePath: row.source_path,
      setup: {
        copyFiles: parseStringArray(row.copy_files) ?? [],
        setupCommand: row.setup_command,
      },
      costUsd: this.runs.projectCost(row.id),
      createdAt: row.created_at,
    };
  }

  /**
   * Finds the project, and where possible the node, that owns a folder.
   *
   * Bonsai creates worktrees and then, later, has no idea what they are: point
   * the folder picker at one and the only thing that answers is git, which
   * replies with a sentence about linked worktrees and advice that leads to a
   * bare repository nobody can adopt. The answer was in the database the whole
   * time.
   *
   * Exact match first -- a node's worktree, or the repository itself -- then
   * containment, which catches the scaffolding around them: the folder holding
   * the bare repo, and the `worktrees/` directory between them.
   */
  folderOwner(path: string): { project: ProjectRow; node: NodeRow | null } | null {
    const target = resolve(path);
    const projects = this.projects.list();

    for (const project of projects) {
      for (const node of this.nodes.list(project.id)) {
        if (resolve(node.worktree_path) === target) return { project, node };
      }
      if (resolve(project.repo_path) === target) return { project, node: null };
      if (project.source_path !== null && resolve(project.source_path) === target) {
        return { project, node: null };
      }
    }

    // Nothing owns it outright; see whether it sits inside something that does.
    // Only Bonsai's own directories count here -- an adopted project's folder
    // is the user's, and a folder next to it is none of Bonsai's business.
    for (const project of projects) {
      const scratch = this.projects.scratchDir(project.id);
      const bare = project.source_kind === 'adopted' ? scratch : dirname(project.repo_path);
      if (isInside(bare, target) || isInside(scratch, target)) return { project, node: null };
    }

    return null;
  }

  /** Whether a node's pinned base still agrees with a live walk. See lineage.ts. */
  baseDiverges(row: NodeRow): boolean {
    const lookup = lookupFrom(this.nodes.list(row.project_id).map(toLineage));
    return divergesFromLiveWalk(toLineage(row), lookup);
  }

  childSourceVersion(parent: NodeRow): string {
    return createHash('sha256')
      .update(JSON.stringify([parent.id, parent.head_commit ?? parent.base_commit]))
      .digest('hex');
  }

  childLineageOf(parent: NodeRow): NodeLineageView {
    return named(parent, this.snapshotSource(parent, parent.head_commit ?? parent.base_commit));
  }

  /**
   * Which node this one took its conversation from, and which it took its code
   * from (PRD §4). The same walk `domain/lineage.ts` already defines -- reused
   * rather than re-derived, because a second implementation of the
   * nearest-committing-ancestor rule is precisely the thing that would drift.
   */
  lineageOf(row: NodeRow): NodeLineageView {
    const parent = row.parent_id === null ? undefined : this.nodes.get(row.parent_id);
    if (parent === undefined) return { conversationFrom: null, codeFrom: null, diverged: false };
    return named(parent, this.snapshotSource(parent, row.base_commit));
  }

  /** Resolve the owner of a pinned snapshot, including an ancestor's older run. */
  private snapshotSource(parent: NodeRow, base: string | null): NodeRow {
    let source: NodeRow | undefined = parent;
    let root = parent;
    while (source !== undefined) {
      root = source;
      if (source.head_commit === base || this.runs.commitsOf(source.id).includes(base ?? ''))
        return source;
      source = source.parent_id === null ? undefined : this.nodes.get(source.parent_id);
    }
    // The initial repository snapshot has no agent run; it belongs to the root.
    return root;
  }
}

function named(parent: NodeRow, source: NodeRow): NodeLineageView {
  return {
    conversationFrom: { id: parent.id, displayName: parent.display_name },
    codeFrom: { id: source.id, displayName: source.display_name },
    diverged: parent.id !== source.id,
  };
}
