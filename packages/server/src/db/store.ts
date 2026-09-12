import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  MessageView,
  NodeStatus,
  NodeView,
  PermissionMode,
  ProjectView,
  RunView,
} from '@bonsai/shared';
import { deriveFlags } from '../domain/flags.js';
import { type LineageNode, lookupFrom, resolveBaseCommit, divergesFromLiveWalk } from '../domain/lineage.js';

/** The full node row. Only the server ever sees this shape. */
export interface NodeRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  display_name: string;
  description: string;
  session_id: string | null;
  forked_from_message_seq: number | null;
  branch_name: string | null;
  base_commit: string | null;
  head_commit: string | null;
  worktree_path: string;
  status: NodeStatus;
  model: string | null;
  permission_mode: PermissionMode | null;
  position_x: number | null;
  position_y: number | null;
  created_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  repo_path: string;
  default_model: string | null;
  default_permission_mode: PermissionMode;
  default_effort: string | null;
  source_kind: 'created' | 'adopted';
  source_path: string | null;
  protected_branch: string | null;
  created_at: string;
}

const now = (): string => new Date().toISOString();

/** What a finished run reports. Cost is an estimate at list price, not a bill. */
export interface RunTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string | null;
  /** 'none' means a subscription login: no per-token charge. */
  apiKeySource?: string | null;
  /** The commit this run produced, if it produced one. */
  commitSha?: string | null;
}

export class Store {
  constructor(
    private readonly db: DatabaseSync,
    private readonly reposRoot: string,
  ) {}

  // -- projects ------------------------------------------------------------

  createProject(input: {
    name: string;
    description: string;
    model: string | null;
    permissionMode: PermissionMode;
    effort?: string | null;
    /** Set when adopting a directory the user already had. */
    adopt?: { repoPath: string; sourcePath: string; protectedBranch: string };
  }): ProjectRow {
    const id = randomUUID();
    const row: ProjectRow = {
      id,
      name: input.name,
      description: input.description,
      repo_path: input.adopt?.repoPath ?? join(this.reposRoot, id, 'repo.git'),
      default_model: input.model,
      default_permission_mode: input.permissionMode,
      default_effort: input.effort ?? null,
      source_kind: input.adopt === undefined ? 'created' : 'adopted',
      source_path: input.adopt?.sourcePath ?? null,
      protected_branch: input.adopt?.protectedBranch ?? null,
      created_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO project (id, name, description, repo_path, default_model,
                              default_permission_mode, default_effort, source_kind,
                              source_path, protected_branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.name,
        row.description,
        row.repo_path,
        row.default_model,
        row.default_permission_mode,
        row.default_effort,
        row.source_kind,
        row.source_path,
        row.protected_branch,
        row.created_at,
      );
    return row;
  }

  listProjects(): ProjectRow[] {
    return this.db
      .prepare(`SELECT * FROM project ORDER BY created_at DESC`)
      .all() as unknown as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare(`SELECT * FROM project WHERE id = ?`).get(id) as
      | unknown as ProjectRow
      | undefined;
  }

  /**
   * The directory Bonsai keeps a project's own files in: the bare repo for a
   * created project, the node worktrees for either kind. Always Bonsai's, never
   * the user's -- which is why deletion can remove it without asking.
   */
  projectScratchDir(projectId: string): string {
    return join(this.reposRoot, projectId);
  }

  /**
   * Records the folder that IS this project, as far as the user is concerned:
   * master's checkout. Set once, just after master exists, because for a
   * created project the default path contains master's own id.
   */
  setProjectSourcePath(id: string, path: string): void {
    this.db.prepare(`UPDATE project SET source_path = ? WHERE id = ?`).run(path, id);
  }

  /** D32: the model and effort a project's runs use. Changing them is not a
   *  node edit -- D3 constrains nodes, not settings. */
  updateProjectSettings(id: string, patch: { model?: string | null; effort?: string | null }): void {
    if (patch.model !== undefined) {
      this.db.prepare(`UPDATE project SET default_model = ? WHERE id = ?`).run(patch.model, id);
    }
    if (patch.effort !== undefined) {
      this.db.prepare(`UPDATE project SET default_effort = ? WHERE id = ?`).run(patch.effort, id);
    }
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

  deleteProject(id: string): void {
    this.db.prepare(`DELETE FROM project WHERE id = ?`).run(id);
  }

  // -- nodes ---------------------------------------------------------------

  /**
   * Inserts a node, pinning its git base via the lineage rule.
   *
   * `baseCommit`/`headCommit` are passed in rather than computed here for
   * master alone -- the root commit is written by the git layer before the
   * project's first node exists. Every other node's base comes from
   * resolveBaseCommit() and is never recomputed afterwards.
   */
  createNode(input: {
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
      const parent = this.getNode(input.parentId);
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
      branch_name: branchName,
      base_commit: baseCommit,
      head_commit: headCommit,
      worktree_path:
        input.worktreePath ?? join(this.reposRoot, input.projectId, 'worktrees', id),
      status: 'new',
      model: input.model ?? null,
      permission_mode: input.permissionMode ?? null,
      position_x: null,
      position_y: null,
      created_at: now(),
    };

    this.db
      .prepare(
        `INSERT INTO node (id, project_id, parent_id, display_name, description,
                           session_id, forked_from_message_seq, branch_name,
                           base_commit, head_commit, worktree_path, status, model,
                           permission_mode, position_x, position_y, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        row.position_x,
        row.position_y,
        row.created_at,
      );
    return row;
  }

  getNode(id: string): NodeRow | undefined {
    return this.db.prepare(`SELECT * FROM node WHERE id = ?`).get(id) as
      | unknown as NodeRow
      | undefined;
  }

  listNodes(projectId: string): NodeRow[] {
    return this.db
      .prepare(`SELECT * FROM node WHERE project_id = ? ORDER BY created_at ASC`)
      .all(projectId) as unknown as NodeRow[];
  }

  /** D33: display name and position only. D3 forbids everything else. */
  updateNode(
    id: string,
    patch: { displayName?: string; positionX?: number | null; positionY?: number | null },
  ): void {
    if (patch.displayName !== undefined) {
      this.db.prepare(`UPDATE node SET display_name = ? WHERE id = ?`).run(patch.displayName, id);
    }
    if (patch.positionX !== undefined || patch.positionY !== undefined) {
      this.db
        .prepare(`UPDATE node SET position_x = ?, position_y = ? WHERE id = ?`)
        .run(patch.positionX ?? null, patch.positionY ?? null, id);
    }
  }

  setNodeStatus(id: string, status: NodeStatus): void {
    this.db.prepare(`UPDATE node SET status = ? WHERE id = ?`).run(status, id);
  }

  /** D7: cascades to descendants via the foreign key. */
  deleteNode(id: string): void {
    this.db.prepare(`DELETE FROM node WHERE id = ?`).run(id);
  }

  /** Every node in the subtree rooted at `id`, deepest first. */
  descendantsOf(id: string): NodeRow[] {
    const all = this.db.prepare(`SELECT * FROM node`).all() as unknown as NodeRow[];
    const childrenOf = new Map<string, NodeRow[]>();
    for (const row of all) {
      if (row.parent_id === null) continue;
      const bucket = childrenOf.get(row.parent_id);
      if (bucket === undefined) childrenOf.set(row.parent_id, [row]);
      else bucket.push(row);
    }
    const out: NodeRow[] = [];
    const visit = (nodeId: string): void => {
      for (const child of childrenOf.get(nodeId) ?? []) visit(child.id);
      const row = all.find((r) => r.id === nodeId);
      if (row !== undefined) out.push(row);
    };
    visit(id);
    return out;
  }

  /** A3: where a child's fork was taken from its parent's conversation. */
  recordFork(id: string, parentMessageSeq: number): void {
    this.db
      .prepare(`UPDATE node SET forked_from_message_seq = ? WHERE id = ?`)
      .run(parentMessageSeq, id);
  }

  messageCount(nodeId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM message WHERE node_id = ?`)
      .get(nodeId) as unknown as { seq: number };
    return Number(row.seq);
  }

  setSessionId(id: string, sessionId: string): void {
    this.db.prepare(`UPDATE node SET session_id = ? WHERE id = ?`).run(sessionId, id);
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

  // -- runs, messages, questions -------------------------------------------

  createRun(runId: string, nodeId: string): void {
    this.db
      .prepare(`INSERT INTO run (id, node_id, status, started_at) VALUES (?, ?, 'running', ?)`)
      .run(runId, nodeId, now());
  }

  finishRun(
    runId: string,
    status: 'done' | 'cancelled' | 'failed',
    error: string | null,
    totals: RunTotals,
  ): void {
    this.db
      .prepare(
        `UPDATE run SET status = ?, ended_at = ?, error = ?, cost = ?,
                        input_tokens = ?, output_tokens = ?,
                        cache_read_tokens = ?, cache_creation_tokens = ?, model = ?,
                        api_key_source = ?, commit_sha = ?
         WHERE id = ?`,
      )
      .run(
        status,
        now(),
        error,
        totals.cost,
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheReadTokens ?? 0,
        totals.cacheCreationTokens ?? 0,
        totals.model ?? null,
        totals.apiKeySource ?? null,
        totals.commitSha ?? null,
        runId,
      );
  }

  getRun(
    runId: string,
  ): { id: string; node_id: string; status: string; commit_sha: string | null } | undefined {
    return this.db
      .prepare(`SELECT id, node_id, status, commit_sha FROM run WHERE id = ?`)
      .get(runId) as unknown as
      | { id: string; node_id: string; status: string; commit_sha: string | null }
      | undefined;
  }

  /**
   * The commit a run should be diffed against: whatever the node was sitting on
   * before it. That is the previous run's commit, or the node's pinned base if
   * this was its first.
   */
  runDiffBase(runId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT (
           SELECT commit_sha FROM run prev
           WHERE prev.node_id = r.node_id AND prev.commit_sha IS NOT NULL
             AND prev.started_at < r.started_at
           ORDER BY prev.started_at DESC LIMIT 1
         ) AS previous,
         (SELECT base_commit FROM node WHERE id = r.node_id) AS base
         FROM run r WHERE r.id = ?`,
      )
      .get(runId) as unknown as { previous: string | null; base: string | null } | undefined;
    return row?.previous ?? row?.base ?? null;
  }

  /** D31: any run still marked running at startup died with the process. */
  markOrphanedRunsInterrupted(): number {
    const runs = this.db
      .prepare(`SELECT id, node_id FROM run WHERE status = 'running'`)
      .all() as unknown as Array<{ id: string; node_id: string }>;
    for (const run of runs) {
      this.db
        .prepare(`UPDATE run SET status = 'failed', ended_at = ?, error = ? WHERE id = ?`)
        .run(now(), 'the app exited while this run was in flight', run.id);
      this.db.prepare(`UPDATE node SET status = 'interrupted' WHERE id = ?`).run(run.node_id);
    }
    return runs.length;
  }


  listRuns(nodeId: string): RunView[] {
    const rows = this.db
      .prepare(`SELECT * FROM run WHERE node_id = ? ORDER BY started_at ASC`)
      .all(nodeId) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      nodeId: r['node_id'] as string,
      status: r['status'] as RunView['status'],
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
      error: (r['error'] as string | null) ?? null,
    }));
  }

  nodeCost(nodeId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost), 0) AS total FROM run WHERE node_id = ?`)
      .get(nodeId) as unknown as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  listMessages(nodeId: string, afterSeq: number): MessageView[] {
    const rows = this.db
      .prepare(`SELECT * FROM message WHERE node_id = ? AND seq > ? ORDER BY seq ASC`)
      .all(nodeId, afterSeq) as unknown as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      nodeId: r['node_id'] as string,
      runId: (r['run_id'] as string | null) ?? null,
      seq: Number(r['seq']),
      role: r['role'] as MessageView['role'],
      kind: r['kind'] as MessageView['kind'],
      content: JSON.parse(r['content_json'] as string) as unknown,
      createdAt: r['created_at'] as string,
    }));
  }

  appendMessage(input: {
    nodeId: string;
    runId: string | null;
    role: MessageView['role'];
    kind: MessageView['kind'];
    content: unknown;
  }): MessageView {
    const next = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM message WHERE node_id = ?`)
      .get(input.nodeId) as unknown as { seq: number };
    const view: MessageView = {
      id: randomUUID(),
      nodeId: input.nodeId,
      runId: input.runId,
      seq: Number(next.seq),
      role: input.role,
      kind: input.kind,
      content: input.content,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO message (id, node_id, run_id, seq, role, kind, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        view.id,
        view.nodeId,
        view.runId,
        view.seq,
        view.role,
        view.kind,
        JSON.stringify(view.content),
        view.createdAt,
      );
    return view;
  }

  /** The last thing the user actually asked for on this node. */
  lastUserPrompt(nodeId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT content_json FROM message
         WHERE node_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1`,
      )
      .get(nodeId) as unknown as { content_json: string } | undefined;
    if (row === undefined) return null;
    try {
      const parsed: unknown = JSON.parse(row.content_json);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  pendingQuestion(nodeId: string): { id: string; text: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, text FROM question
         WHERE node_id = ? AND answered_at IS NULL
         ORDER BY asked_at DESC LIMIT 1`,
      )
      .get(nodeId) as unknown as { id: string; text: string } | undefined;
    return row ?? null;
  }

  // -- views ---------------------------------------------------------------

  /** Assembles NodeViews for a project, deriving every flag from the tree. */
  treeView(projectId: string): NodeView[] {
    const project = this.getProject(projectId);
    const rows = this.listNodes(projectId);
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
      const question = row.status === 'needs_you' ? this.pendingQuestion(row.id) : null;
      return {
        id: row.id,
        projectId: row.project_id,
        parentId: row.parent_id,
        displayName: row.display_name,
        // §7: for needs_you the card shows the agent's question instead, which
        // is what makes the canvas triageable at a glance.
        summaryLine: question?.text ?? row.description,
        status: row.status,
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
        costUsd: this.nodeCost(row.id),
        createdAt: row.created_at,
      } satisfies NodeView;
    });
  }

  projectView(row: ProjectRow): ProjectView {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      defaultModel: row.default_model,
      defaultPermissionMode: row.default_permission_mode,
      defaultEffort: row.default_effort,
      sourceKind: row.source_kind,
      sourcePath: row.source_path,
      costUsd: this.projectCost(row.id),
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
  findFolderOwner(path: string): { project: ProjectRow; node: NodeRow | null } | null {
    const target = resolve(path);

    for (const project of this.listProjects()) {
      for (const node of this.listNodes(project.id)) {
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
    for (const project of this.listProjects()) {
      const scratch = this.projectScratchDir(project.id);
      const bare = project.source_kind === 'adopted' ? scratch : dirname(project.repo_path);
      if (isInside(bare, target) || isInside(scratch, target)) return { project, node: null };
    }

    return null;
  }

  /** Whether a node's pinned base still agrees with a live walk. See lineage.ts. */
  baseDiverges(row: NodeRow): boolean {
    const lookup = lookupFrom(this.listNodes(row.project_id).map(toLineage));
    return divergesFromLiveWalk(toLineage(row), lookup);
  }
}

/** True for the one node whose worktree the user owns: an adopted master. */
export function isUsersOwnCheckout(
  project: ProjectRow | undefined,
  row: NodeRow,
): boolean {
  return project?.source_kind === 'adopted' && row.parent_id === null;
}

export function toLineage(row: NodeRow): LineageNode {
  return {
    id: row.id,
    parentId: row.parent_id,
    baseCommit: row.base_commit,
    headCommit: row.head_commit,
  };
}

function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  return child === p || child.startsWith(p + sep);
}
