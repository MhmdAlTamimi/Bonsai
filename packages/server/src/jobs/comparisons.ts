import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { plural, type RunReferenceView } from '@bonsai/shared';

import type { Comparer, RunEvent } from '../agent/AgentRunner.js';
import { explainAgentError } from '../agent/claudeCode.js';
import type { EventBus } from '../api/events.js';
import type { ComparisonRow, NodeRow, Store } from '../db/store.js';
import { OperationConflict } from '../domain/errors.js';
import type { Logger } from '../log.js';
import {
  comparisonFolder,
  snapshotForComparison,
  writeComparisonIndex,
} from './comparisonSnapshot.js';
import { folderNames } from './experimentSnapshot.js';
import { fileNames } from './runContext.js';
import { revisionOf } from '../db/referenceStore.js';
import { CONCURRENCY } from '@bonsai/shared';
import { ExecutionPool } from './executionPool.js';
import { boundedConversation, CONVERSATION_RECOVERY_NOTICE } from './conversationRecovery.js';

/** What a comparison needs from the app's settings. */
export interface ComparisonSettings {
  maxConcurrentRuns?(): number;
  model(): string | null;
  effort(): string | null;
  agentEnv(): Record<string, string> | null;
}

/**
 * Comparisons: made from 2-4 experiments, asked questions, brought up to date.
 *
 * Deliberately separate from the run pipeline. A comparison has no checkout,
 * commits nothing and touches no experiment. Questions share the same process
 * bound as runs and drafts; their files remain owned until cleanup finishes.
 */
export class ComparisonJobs {
  private readonly active = new Map<string, AbortController>();
  private readonly turns = new Map<string, string>();
  private readonly deleting = new Set<string>();
  readonly pool: ExecutionPool;

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly comparer: Comparer,
    private readonly settings: ComparisonSettings,
    private readonly log: Logger,
    pool?: ExecutionPool,
  ) {
    this.pool =
      pool ?? new ExecutionPool(() => settings.maxConcurrentRuns?.() ?? CONCURRENCY.default);
  }

  isRunning(comparisonId: string): boolean {
    return this.active.has(comparisonId);
  }

  queuePosition(comparisonId: string): number | null {
    const turnId = this.turns.get(comparisonId);
    return turnId ? this.pool.position(turnId) : null;
  }

  /** Snapshots the experiments and records the comparison. Nothing is asked yet. */
  async create(projectId: string, nodes: readonly NodeRow[]): Promise<ComparisonRow> {
    const title = nodes.map((node) => node.display_name).join(' vs ');
    const row = this.store.comparisons.create(projectId, title, []);
    const root = comparisonFolder(this.store, projectId, row.id);
    const folders = folderNames(nodes.map((node) => node.display_name));
    try {
      for (const [position, node] of nodes.entries()) {
        const input = await snapshotForComparison(this.store, node, root, folders[position]!);
        this.store.comparisons.replaceExperiment(row.id, position, input);
      }
      await writeComparisonIndex(
        root,
        nodes.map((node, i) => ({ name: node.display_name, folder: folders[i]! })),
      );
    } catch (error) {
      this.store.comparisons.delete(row.id);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
    this.log.info('comparison.created', { comparisonId: row.id, experiments: nodes.length });
    this.publish(row);
    return row;
  }

  /**
   * Takes a fresh snapshot of every experiment that has moved on, says so in
   * the conversation, and tells the agent with the next question -- otherwise
   * it would keep relying on what it read before.
   */
  async refresh(comparisonId: string): Promise<string[]> {
    const row = this.require(comparisonId);
    if (this.isRunning(row.id)) {
      throw new OperationConflict('Wait for the current answer before updating.');
    }
    const root = comparisonFolder(this.store, row.project_id, row.id);
    const view = this.store.comparisonView(row);
    const stored = this.store.comparisons.experiments(row.id);
    const updated: string[] = [];
    for (const [position, experiment] of view.experiments.entries()) {
      const node = experiment.nodeId === null ? undefined : this.store.getNode(experiment.nodeId);
      if (node === undefined || experiment.newRuns === 0) continue;
      const input = await snapshotForComparison(this.store, node, root, stored[position]!.folder);
      this.store.comparisons.replaceExperiment(row.id, position, input);
      updated.push(`${node.display_name} (${plural(experiment.newRuns, 'new run')})`);
    }
    if (updated.length > 0) {
      const names = updated.join(', ');
      this.store.comparisons.appendMessage({
        comparisonId: row.id,
        turnId: null,
        role: 'system',
        kind: 'text',
        content: `Updated to their latest work: ${names}.`,
      });
      this.store.comparisons.setPendingNote(
        row.id,
        `Since your last answer, the snapshots of ${names} were updated to their latest ` +
          'committed work. Re-read what you rely on from them.',
      );
      this.store.comparisons.touch(row.id);
      this.log.info('comparison.refreshed', { comparisonId: row.id, updated: updated.length });
      this.publish(row);
    }
    return updated;
  }

  /**
   * Experiments are about to be deleted. Returns what to do once they are:
   * each comparison that includes one says so in its conversation, and tells
   * its agent with the next question.
   *
   * A comparison is not blocked by this and does not stop working: it holds
   * its own copy of every experiment it read, outside the experiment's folders,
   * so it stays readable and can still be asked about. What it can no longer do
   * is update that experiment. Read before the delete, because deleting clears
   * the link from the comparison to the experiment.
   */
  beforeDeleting(nodeIds: readonly string[]): () => void {
    const doomed = new Set(nodeIds);
    const affected = this.store.comparisons.including(nodeIds).map(({ id }) => ({
      id,
      names: this.store.comparisons
        .experiments(id)
        .filter((experiment) => experiment.nodeId !== null && doomed.has(experiment.nodeId))
        .map((experiment) => experiment.name),
    }));
    return () => {
      for (const { id, names } of affected) {
        const row = this.store.comparisons.get(id);
        if (row === undefined || names.length === 0) continue;
        const list = names.join(', ');
        const one = names.length === 1;
        this.store.comparisons.appendMessage({
          comparisonId: id,
          turnId: null,
          role: 'system',
          kind: 'text',
          content:
            `${list} ${one ? 'was' : 'were'} deleted from the project. This comparison keeps the ` +
            `copy it read, but can no longer update ${one ? 'it' : 'them'}.`,
        });
        const note =
          `Since your last answer, ${list} ${one ? 'was' : 'were'} deleted from the project. ` +
          `${one ? 'Its folder' : 'Their folders'} here ${one ? 'is' : 'are'} the only copy left; ` +
          'say so if a question depends on continuing that work.';
        this.store.comparisons.setPendingNote(
          id,
          row.pending_note === null ? note : `${row.pending_note}\n\n${note}`,
        );
        this.store.comparisons.touch(id);
        this.publish(row);
      }
    };
  }

  /**
   * Asks the comparison's agent a question. It answers in the background.
   *
   * References go with the question the way they go with a run: read now, so
   * an edit after pressing send belongs to the next question; written as
   * read-only copies in the comparison's own folder, per question, so each
   * answer keeps exactly what it read; and looked up by the agent rather than
   * pasted in. The ids are checked by the caller (attachedReferences).
   */
  ask(
    comparisonId: string,
    prompt: string,
    referenceIds: readonly string[] = [],
  ): { turnId: string } {
    const row = this.require(comparisonId);
    this.pool.assertAvailable(row.project_id);
    if (this.deleting.has(row.id)) throw new OperationConflict('This comparison is being deleted.');
    if (this.isRunning(row.id)) throw new OperationConflict('This comparison is still answering.');
    const rows = referenceIds.flatMap((id) => this.store.references.get(id) ?? []);
    const files = fileNames(rows.map((reference) => reference.name));
    const attached = rows.map((reference, index) => ({
      view: {
        id: reference.id,
        name: reference.name,
        revision: revisionOf(reference.content),
        size: reference.content.length,
        file: files[index]!,
      } satisfies RunReferenceView,
      content: reference.content,
    }));
    const turnId = this.store.comparisons.startTurn(
      row.id,
      attached.map((a) => a.view),
    );
    this.store.comparisons.appendMessage({
      comparisonId: row.id,
      turnId,
      role: 'user',
      kind: 'text',
      content: prompt,
    });
    const controller = new AbortController();
    this.active.set(row.id, controller);
    this.turns.set(row.id, turnId);
    this.publish(row);
    this.pool.enqueue(
      { id: turnId, projectId: row.project_id, kind: 'comparison', label: row.title, controller },
      () => this.answer(row, turnId, prompt, attached, controller),
      () => {
        this.store.comparisons.finishTurn(turnId, {
          status: 'cancelled',
          costUsd: 0,
          model: null,
          error: null,
        });
        this.active.delete(row.id);
        this.turns.delete(row.id);
        this.publish(row);
      },
    );
    return { turnId };
  }

  stop(comparisonId: string): void {
    this.active.get(comparisonId)?.abort();
  }

  async delete(comparisonId: string): Promise<void> {
    const row = this.require(comparisonId);
    if (this.deleting.has(row.id)) throw new OperationConflict('Deletion is already in progress.');
    this.deleting.add(row.id);
    try {
      this.stop(row.id);
      const deadline = Date.now() + 10000;
      while (this.isRunning(row.id)) {
        if (Date.now() >= deadline)
          throw new OperationConflict(
            'The comparison is still stopping. Its files are preserved; retry shortly.',
          );
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      this.store.comparisons.delete(row.id);
      await rm(comparisonFolder(this.store, row.project_id, row.id), {
        recursive: true,
        force: true,
      });
      this.publish(row);
    } finally {
      this.deleting.delete(row.id);
    }
  }

  /** Stops every answer and waits, briefly, for them to be recorded. */
  async drain(timeoutMs = 3000): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async answer(
    row: ComparisonRow,
    turnId: string,
    question: string,
    attached: ReadonlyArray<{ view: RunReferenceView; content: string }>,
    controller: AbortController,
  ): Promise<void> {
    const project = this.store.getProject(row.project_id);
    const note = row.pending_note;
    let cost = 0;
    let model: string | null = null;
    let apiKeySource: string | null = null;
    let error: string | null = null;
    const startedAt = Date.now();
    try {
      const cwd = comparisonFolder(this.store, row.project_id, row.id);
      let resumeSessionId = row.session_id;
      if (
        resumeSessionId !== null &&
        this.comparer.conversationAvailable &&
        !(await this.comparer.conversationAvailable(resumeSessionId, cwd))
      ) {
        this.store.comparisons.setSession(row.id, null);
        resumeSessionId = null;
        this.record(row, turnId, { type: 'notice', text: CONVERSATION_RECOVERY_NOTICE });
      }
      const previous = this.store.comparisons
        .messages(row.id)
        .filter((message) => message.turnId !== turnId);
      const history =
        resumeSessionId === null && previous.length > 0
          ? boundedConversation(previous, 24_000)
          : '';
      const prompt = note === null ? question : `${note}\n\n${question}`;
      if (note !== null) this.store.comparisons.setPendingNote(row.id, null);
      const folder = turnReferencesFolder(this.store, row.project_id, row.id, turnId);
      if (attached.length > 0) await mkdir(folder, { recursive: true });
      for (const { view, content } of attached) {
        await writeFile(join(folder, view.file), content, { flag: 'wx', mode: 0o400 });
      }
      for await (const event of this.comparer.compare({
        comparisonId: row.id,
        cwd,
        prompt:
          history.trim() === ''
            ? prompt
            : `Bonsai saved conversation: use the following prior context. Older messages and tool output may be shortened.\n\n${history}\n\nCurrent request:\n${prompt}`,
        references: attached.map(({ view }) => ({
          name: view.name,
          path: join(folder, view.file),
        })),
        resumeSessionId,
        model: project?.default_model ?? this.settings.model(),
        effort: project?.default_effort ?? this.settings.effort(),
        agentEnv: this.settings.agentEnv(),
        signal: controller.signal,
      })) {
        if (event.type === 'session') this.store.comparisons.setSession(row.id, event.sessionId);
        else if (event.type === 'model') {
          model = event.model;
          apiKeySource = event.apiKeySource ?? null;
        } else if (event.type === 'done') {
          cost = event.costUsd;
          model = event.model ?? model;
          this.store.comparisons.recordUsage(turnId, { ...event, model }, apiKeySource);
          this.publish(row);
        } else if (event.type === 'error') error = event.error;
        else this.record(row, turnId, event);
      }
    } catch (err) {
      error = explainAgentError(err instanceof Error ? err.message : String(err));
    } finally {
      const status = controller.signal.aborted ? 'cancelled' : error === null ? 'done' : 'failed';
      this.store.comparisons.finishTurn(turnId, { status, costUsd: cost, model, error });
      this.active.delete(row.id);
      this.turns.delete(row.id);
      // Sizes and outcome, never the question or the answer.
      this.log.info('comparison.answered', {
        comparisonId: row.id,
        status,
        durationMs: Date.now() - startedAt,
        costUsd: cost,
      });
      this.publish(row);
    }
  }

  /** The answer's words and reads, as the same kinds of message an experiment's run writes. */
  private record(row: ComparisonRow, turnId: string, event: RunEvent): void {
    const message =
      event.type === 'text'
        ? { kind: 'text' as const, content: event.text }
        : event.type === 'notice'
          ? { kind: 'text' as const, content: event.text }
          : event.type === 'tool'
            ? {
                kind: 'tool_use' as const,
                content: {
                  name: event.name,
                  detail: event.detail,
                  ...(event.id === undefined ? {} : { id: event.id }),
                  ...(event.description === undefined ? {} : { description: event.description }),
                  ...(event.parentToolUseId === undefined
                    ? {}
                    : { parentToolUseId: event.parentToolUseId }),
                },
              }
            : event.type === 'tool_result'
              ? { kind: 'tool_result' as const, content: event.result }
              : null;
    if (message === null) return;
    this.store.comparisons.appendMessage({
      comparisonId: row.id,
      turnId,
      role: event.type === 'notice' ? 'system' : 'assistant',
      ...message,
    });
    this.publish(row);
  }

  private require(comparisonId: string): ComparisonRow {
    const row = this.store.comparisons.get(comparisonId);
    if (row === undefined) throw new OperationConflict('That comparison no longer exists.');
    if (
      this.store.deletions
        .pending()
        .some((intent) => intent.kind === 'project' && intent.project.id === row.project_id)
    )
      throw new OperationConflict('Finish or cancel the project’s pending deletion first.');
    return row;
  }

  private publish(row: ComparisonRow): void {
    this.bus.publish(row.project_id, {
      type: 'comparison.updated',
      projectId: row.project_id,
      comparisonId: row.id,
    });
  }
}

/** Where one question's references are copied: inside the comparison, so its agent can read them. */
function turnReferencesFolder(
  store: Store,
  projectId: string,
  comparisonId: string,
  turnId: string,
): string {
  // `_` cannot begin an experiment's folder name (folderNames), so this never
  // lands on an experiment called "questions".
  return join(comparisonFolder(store, projectId, comparisonId), '_questions', turnId);
}

/** The exact text a comparison's question was given for one of its references. */
export async function readComparisonReference(
  store: Store,
  comparisonId: string,
  turnId: string,
  reference: RunReferenceView,
): Promise<string> {
  // The recorded name is a bare file name; anything else is not ours to read.
  if (basename(reference.file) !== reference.file) throw new Error('not a reference copy');
  const row = store.comparisons.get(comparisonId);
  if (row === undefined) throw new Error('no such comparison');
  return readFile(
    join(turnReferencesFolder(store, row.project_id, comparisonId, turnId), reference.file),
    'utf8',
  );
}
