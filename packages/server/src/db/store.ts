import type { DatabaseSync } from 'node:sqlite';
import type {
  ComparisonSummary,
  ComparisonView,
  MessageView,
  NodeLineageView,
  NodeStatus,
  NodeView,
  PermissionMode,
  ProjectView,
  ReferenceView,
  RunView,
} from '@bonsai/shared';

import { CheckStore } from './checkStore.js';
import { ComparisonStore, type ComparisonRow } from './comparisonStore.js';
import { MessageStore } from './messageStore.js';
import { SaveStore } from './saveStore.js';
import { DeletionStore } from './deletionStore.js';
import { SdkSessionStore } from './sdkSessionStore.js';
import { UsageStore } from './usageStore.js';
import { NodeStore } from './nodeStore.js';
import { ProjectStore } from './projectStore.js';
import { ReferenceStore } from './referenceStore.js';
import { RunStore } from './runStore.js';
import { Views } from './views.js';
import type { NodeRow, ProjectRow, RunEnd, RunRequest, RunTotals } from './rows.js';
import type { ReferenceRow } from './referenceStore.js';

export type { NodeRow, ProjectRow, RunEnd, RunTotals };
export { isAdoptedRoot, isUsersOwnCheckout, toLineage } from './rows.js';
export type { NodeChecks, TestingSource } from './checkStore.js';
export type { StoredQuestion } from './messageStore.js';
export type { ReferenceRow } from './referenceStore.js';
export type {
  ComparisonRow,
  ComparedExperimentInput,
  ComparedExperimentRow,
} from './comparisonStore.js';

/**
 * The database, as one object with seven concerns behind it.
 *
 * It used to be one class of fifty methods over five tables, and every feature
 * made it longer: projects, nodes, runs, messages and checks all edited the
 * same file, so "where does this belong" had one answer and no boundary. The
 * concerns are now separate modules -- `projectStore`, `nodeStore`, `runStore`,
 * `messageStore`, `checkStore` -- with `views` assembling what the interface
 * reads.
 *
 * This class stays, deliberately, as a FACADE. It is the only thing the rest of
 * the server holds, so splitting the implementation cost the callers nothing,
 * and it is where a change that genuinely spans concerns (deleting a project,
 * building a tree) is allowed to live. The sub-stores are reachable as
 * `store.projects`, `store.nodes` and so on for new code that wants to say
 * which concern it is touching; the flat methods below are the same thing under
 * the names the codebase already uses.
 *
 * WHAT MUST NOT HAPPEN HERE: a sub-store reaching into another sub-store. The
 * one exception is `views`, which exists precisely to read across them, and it
 * only reads.
 */
export class Store {
  readonly projects: ProjectStore;
  readonly nodes: NodeStore;
  readonly runs: RunStore;
  readonly messages: MessageStore;
  readonly saves: SaveStore;
  readonly deletions: DeletionStore;
  readonly sdkSessions: SdkSessionStore;
  readonly usage: UsageStore;
  readonly checks: CheckStore;
  readonly references: ReferenceStore;
  readonly comparisons: ComparisonStore;
  readonly views: Views;

  constructor(
    private readonly db: DatabaseSync,
    reposRoot: string,
    futureReposRoot?: () => string,
  ) {
    this.projects = new ProjectStore(db, reposRoot, futureReposRoot);
    this.nodes = new NodeStore(db, (projectId) => this.projects.scratchDir(projectId));
    this.runs = new RunStore(db);
    this.messages = new MessageStore(db);
    this.saves = new SaveStore(db);
    this.deletions = new DeletionStore(db);
    this.sdkSessions = new SdkSessionStore(db);
    this.usage = new UsageStore(db);
    this.checks = new CheckStore(db);
    this.references = new ReferenceStore(db);
    this.comparisons = new ComparisonStore(db);
    this.views = new Views(
      this.projects,
      this.nodes,
      this.runs,
      this.messages,
      this.comparisons,
      this.deletions,
    );
  }

  // -- projects ------------------------------------------------------------

  metadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }
  setMetadata(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  /** Includes committed WAL pages; callers must exclude concurrent filesystem writers. */
  snapshotDatabase(file: string): void {
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  /** One relocation updates owned paths and durable recovery records together. */
  remapProjectPaths(projectId: string, map: (path: string) => string): void {
    const project = this.getProject(projectId)!;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('UPDATE project SET repo_path = ?, scratch_path = ?, source_path = ? WHERE id = ?')
        .run(
          map(project.repo_path),
          project.scratch_path === null ? null : map(project.scratch_path),
          project.source_path === null ? null : map(project.source_path),
          projectId,
        );
      for (const node of this.listNodes(projectId))
        this.db
          .prepare('UPDATE node SET worktree_path = ? WHERE id = ?')
          .run(map(node.worktree_path), node.id);
      for (const save of this.saves.pending()) {
        if (save.projectId !== projectId) continue;
        save.repoPath = map(save.repoPath);
        save.worktreePath = map(save.worktreePath);
        save.before.commonDir = map(save.before.commonDir);
        this.db
          .prepare('UPDATE run_save SET payload_json = ? WHERE run_id = ?')
          .run(JSON.stringify(save), save.runId);
      }
      for (const intent of this.deletions.pending()) {
        if (intent.project.id !== projectId) continue;
        intent.project.repo_path = map(intent.project.repo_path);
        if (intent.project.scratch_path !== null)
          intent.project.scratch_path = map(intent.project.scratch_path);
        if (intent.project.source_path !== null)
          intent.project.source_path = map(intent.project.source_path);
        intent.nodes = intent.nodes.map((node) => ({
          ...node,
          worktree_path: map(node.worktree_path),
        }));
        this.db
          .prepare('UPDATE deletion_operation SET payload_json = ? WHERE id = ?')
          .run(JSON.stringify(intent), intent.id);
      }
      this.setMetadata(`relocation:${projectId}`, null);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordRecoveredExperiment(
    input: Parameters<NodeStore['create']>[0],
    commit: string,
    branch: string | null,
    allocated: boolean,
  ): NodeRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const node = this.nodes.create(input);
      this.nodes.recordCommit(
        node.id,
        branch ?? `refs/bonsai/${node.project_id}/${node.id}`,
        commit,
      );
      this.nodes.markAllocated(node.id, allocated);
      this.nodes.setStatus(node.id, allocated ? 'interrupted' : 'ready');
      this.db.exec('COMMIT');
      return this.nodes.get(node.id)!;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveProjectConfiguration(...args: Parameters<ProjectStore['saveConfiguration']>): void {
    this.projects.saveConfiguration(...args);
  }
  createProject(input: Parameters<ProjectStore['create']>[0]): ProjectRow {
    return this.projects.create(input);
  }
  listProjects(): ProjectRow[] {
    return this.projects.list();
  }
  getProject(id: string): ProjectRow | undefined {
    return this.projects.get(id);
  }
  projectScratchDir(projectId: string): string {
    return this.projects.scratchDir(projectId);
  }
  setProjectSourcePath(id: string, path: string): void {
    this.projects.setSourcePath(id, path);
  }
  updateProjectSetup(...args: Parameters<ProjectStore['updateSetup']>): void {
    this.projects.updateSetup(...args);
  }
  updateProjectSettings(...args: Parameters<ProjectStore['updateSettings']>): void {
    this.projects.updateSettings(...args);
  }
  projectCost(projectId: string): number {
    return this.runs.projectCost(projectId);
  }
  deleteProject(id: string): void {
    this.projects.delete(id);
  }

  // -- nodes ---------------------------------------------------------------

  createNode(input: Parameters<NodeStore['create']>[0]): NodeRow {
    return this.nodes.create(input);
  }
  getNode(id: string): NodeRow | undefined {
    return this.nodes.get(id);
  }
  listNodes(projectId: string): NodeRow[] {
    return this.nodes.list(projectId);
  }
  updateNode(...args: Parameters<NodeStore['update']>): void {
    this.nodes.update(...args);
  }
  setNodeStatus(id: string, status: NodeStatus): void {
    this.nodes.setStatus(id, status);
  }
  deleteNode(id: string): void {
    this.nodes.delete(id);
  }
  completeDeletion(id: string, kind: 'node' | 'project', targetId: string): void {
    this.transaction(() => {
      if (kind === 'node') this.nodes.delete(targetId);
      else this.projects.delete(targetId);
      this.deletions.remove(id);
    });
  }
  cancelDeletion(id: string): void {
    this.transaction(() => {
      const intent = this.deletions.get(id);
      if (intent === undefined) return;
      for (const node of intent.nodes) this.nodes.setStatus(node.id, 'interrupted');
      this.deletions.remove(id);
    });
  }
  descendantsOf(id: string): NodeRow[] {
    return this.nodes.descendantsOf(id);
  }
  adoptForkedSession(
    id: string,
    sessionId: string | null,
    parentMessageSeq: number,
    historySeed?: string,
  ): void {
    this.transaction(() => {
      this.nodes.adoptForkedSession(id, sessionId, parentMessageSeq);
      if (historySeed !== undefined) this.setMetadata(`conversation_seed:${id}`, historySeed);
      const checkpoint = sessionId === null ? null : this.sdkSessions.checkpoint(sessionId);
      this.setMetadata(`session_boundary:${id}`, checkpoint === null ? null : String(checkpoint));
    });
  }
  setSessionPosition(id: string, messageId: string | null): void {
    this.nodes.setSessionPosition(id, messageId);
  }
  markAllocated(id: string, allocated: boolean): void {
    this.nodes.markAllocated(id, allocated);
  }
  recordRunContext(...args: Parameters<RunStore['recordContext']>): void {
    this.runs.recordContext(...args);
  }

  setSessionId(id: string, sessionId: string | null): void {
    this.transaction(() => {
      if (this.nodes.get(id)?.session_id !== sessionId)
        this.setMetadata(`session_boundary:${id}`, null);
      this.nodes.setSessionId(id, sessionId);
    });
  }
  markSetupRan(nodeId: string): void {
    this.nodes.markSetupRan(nodeId);
  }
  markArchived(id: string): void {
    this.nodes.markArchived(id);
  }
  markRestored(id: string): void {
    this.nodes.markRestored(id);
  }
  lastActive(projectId: string): Map<string, string> {
    return this.nodes.lastActive(projectId);
  }
  recordCommit(id: string, branchName: string, headCommit: string): void {
    this.nodes.recordCommit(id, branchName, headCommit);
  }

  // -- runs ----------------------------------------------------------------

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Accepting a request is durable before scheduling or returning HTTP 202. */
  enqueueRun(runId: string, nodeId: string, request: RunRequest): void {
    this.transaction(() => {
      this.runs.create(runId, nodeId, request);
      this.messages.append({ nodeId, runId, role: 'user', kind: 'text', content: request.prompt });
      this.nodes.setStatus(nodeId, 'running');
    });
  }

  /** The Git commit precedes this transaction; all database consequences land together. */
  completeRun(
    runId: string,
    nodeId: string,
    end: RunEnd,
    totals: RunTotals,
    node: {
      status: NodeStatus;
      commit?: { branch: string; head: string };
      sessionPosition?: string | null;
      abandonSaves?: readonly string[];
      restored?: boolean;
    },
  ): void {
    this.transaction(() => {
      if (node.commit !== undefined)
        this.nodes.recordCommit(nodeId, node.commit.branch, node.commit.head);
      this.runs.finish(runId, end, totals);
      if (node.sessionPosition !== undefined)
        this.nodes.setSessionPosition(nodeId, node.sessionPosition);
      if (end.status === 'done' && node.sessionPosition !== undefined) {
        const sessionId = this.nodes.get(nodeId)?.session_id;
        const checkpoint = sessionId ? this.sdkSessions.checkpoint(sessionId) : null;
        if (checkpoint !== null) this.setMetadata(`session_boundary:${nodeId}`, String(checkpoint));
      }
      this.nodes.setStatus(nodeId, node.status);
      if (end.status === 'done') this.saves.remove(runId);
      for (const id of node.abandonSaves ?? []) this.saves.remove(id);
      if (node.restored) this.nodes.markRestored(nodeId);
    });
  }

  createRun(runId: string, nodeId: string): void {
    this.runs.create(runId, nodeId);
  }
  finishRun(runId: string, end: RunEnd, totals: RunTotals): void {
    this.runs.finish(runId, end, totals);
  }
  getRun(runId: string): ReturnType<RunStore['get']> {
    return this.runs.get(runId);
  }
  listRuns(nodeId: string): RunView[] {
    return this.runs.list(nodeId);
  }
  nodeCost(nodeId: string): number {
    return this.runs.costOf(nodeId);
  }
  counts(): { projects: number; nodes: number; runs: number; running: number } {
    return this.runs.counts();
  }
  markOrphanedRunsInterrupted(): number {
    return this.transaction(
      () => this.runs.markOrphanedInterrupted() + this.comparisons.markOrphanedTurnsFailed(),
    );
  }

  // -- messages, questions and checks ---------------------------------------

  listMessages(nodeId: string, afterSeq: number): MessageView[] {
    return this.messages.list(nodeId, afterSeq);
  }
  appendMessage(input: Parameters<MessageStore['append']>[0]): MessageView {
    return this.messages.append(input);
  }
  messageCount(nodeId: string): number {
    return this.messages.count(nodeId);
  }
  lastUserPrompt(nodeId: string): string | null {
    return this.messages.lastUserPrompt(nodeId);
  }
  askQuestion(input: Parameters<MessageStore['askQuestion']>[0]): void {
    this.messages.askQuestion(input);
  }
  answerQuestion(questionId: string, answer: string): boolean {
    return this.messages.answerQuestion(questionId, answer);
  }
  getQuestion(questionId: string): ReturnType<MessageStore['getQuestion']> {
    return this.messages.getQuestion(questionId);
  }
  pendingQuestion(nodeId: string): NodeView['pendingQuestion'] {
    return this.messages.pendingQuestion(nodeId);
  }
  testingSource(commit: string): ReturnType<CheckStore['sourceOf']> {
    return this.checks.sourceOf(commit);
  }

  // -- views ---------------------------------------------------------------

  treeView(projectId: string): NodeView[] {
    return this.views.tree(projectId);
  }
  projectView(row: ProjectRow): ProjectView {
    return this.views.project(row);
  }
  findFolderOwner(path: string): { project: ProjectRow; node: NodeRow | null } | null {
    return this.views.folderOwner(path);
  }
  baseDiverges(row: NodeRow): boolean {
    return this.views.baseDiverges(row);
  }
  childSourceVersion(parent: NodeRow): string {
    return this.views.childSourceVersion(parent);
  }
  childLineageOf(parent: NodeRow): NodeLineageView {
    return this.views.childLineageOf(parent);
  }
  lineageOf(row: NodeRow): NodeLineageView {
    return this.views.lineageOf(row);
  }
  referenceView(row: ReferenceRow): ReferenceView {
    return this.views.reference(row);
  }
  comparisonView(row: ComparisonRow): ComparisonView {
    return this.views.comparison(row);
  }
  comparisonSummaries(projectId: string, running: (id: string) => boolean): ComparisonSummary[] {
    return this.views.comparisonSummaries(projectId, running);
  }
}

export type { PermissionMode };
