import type { DatabaseSync } from 'node:sqlite';
import type {
  MessageView,
  NodeLineageView,
  NodeStatus,
  NodeView,
  PermissionMode,
  ProjectView,
  RunView,
} from '@bonsai/shared';

import { CheckStore } from './checkStore.js';
import { MessageStore } from './messageStore.js';
import { NodeStore } from './nodeStore.js';
import { ProjectStore } from './projectStore.js';
import { RunStore } from './runStore.js';
import { Views } from './views.js';
import type { NodeRow, ProjectRow, RunTotals } from './rows.js';

export type { NodeRow, ProjectRow, RunTotals };
export { isUsersOwnCheckout, toLineage } from './rows.js';
export type { NodeChecks, TestingSource } from './checkStore.js';

/**
 * The database, as one object with five concerns behind it.
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
  readonly checks: CheckStore;
  readonly views: Views;

  constructor(db: DatabaseSync, reposRoot: string, futureReposRoot?: () => string) {
    this.projects = new ProjectStore(db, reposRoot, futureReposRoot);
    this.nodes = new NodeStore(db, (projectId) => this.projects.scratchDir(projectId));
    this.runs = new RunStore(db);
    this.messages = new MessageStore(db);
    this.checks = new CheckStore(db);
    this.views = new Views(this.projects, this.nodes, this.runs, this.messages);
  }

  // -- projects ------------------------------------------------------------

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
  descendantsOf(id: string): NodeRow[] {
    return this.nodes.descendantsOf(id);
  }
  recordFork(id: string, parentMessageSeq: number): void {
    this.nodes.recordFork(id, parentMessageSeq);
  }
  setSessionId(id: string, sessionId: string): void {
    this.nodes.setSessionId(id, sessionId);
  }
  markSetupRan(nodeId: string): void {
    this.nodes.markSetupRan(nodeId);
  }
  recordCommit(id: string, branchName: string, headCommit: string): void {
    this.nodes.recordCommit(id, branchName, headCommit);
  }

  // -- runs ----------------------------------------------------------------

  createRun(runId: string, nodeId: string): void {
    this.runs.create(runId, nodeId);
  }
  finishRun(
    runId: string,
    status: 'done' | 'cancelled' | 'failed',
    error: string | null,
    totals: RunTotals,
  ): void {
    this.runs.finish(runId, status, error, totals);
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
    return this.runs.markOrphanedInterrupted();
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
}

export type { PermissionMode };
